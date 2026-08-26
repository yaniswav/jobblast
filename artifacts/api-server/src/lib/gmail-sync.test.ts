import { describe, expect, it } from "vitest";
// gmail-sync.ts imports @workspace/db (via itself and via ai/interview-brief),
// which throws at import time without DATABASE_URL. vitest.config.ts sets a
// fake, never-dialed one (pg's Pool connects lazily) so this import is safe
// with no real Postgres - see the comment there.
import { companyMatches, evaluateEmail, normalizeCompany, type GmailEmail, type TrackedApplication } from "./gmail-sync";

describe("normalizeCompany", () => {
  it("folds accents, punctuation and repeated legal suffixes, but never empties the name", () => {
    expect(normalizeCompany("Foo GmbH & Co. KG")).toBe("foo");
    expect(normalizeCompany("SA")).toBe("sa"); // a company literally called "SA" keeps its token
    expect(normalizeCompany("Société Générale")).toBe("societe generale");
  });
});

describe("companyMatches", () => {
  const cases: Array<[label: string, a: string, b: string, expected: boolean]> = [
    ["accent-folded exact match", "Société Générale", "SOCIETE GENERALE", true],
    ["legal suffix stripped on one side", "Qonto SAS", "Qonto", true],
    ["trailing punctuation ignored", "Doctolib.", "Doctolib", true],
    ["'Thales' is a whole-token run inside 'Thales Group'", "THALES", "Thales Group", true],
    ["'Orange' does not match 'Orangerie' (whole-token, not substring)", "Orange", "Orangerie", false],
    ["short acronyms need exact equality, not containment", "IBM", "IBM Global", false],
    ["names too short to compare at all never match", "SA", "SA Corp", false],
  ];

  it.each(cases)("%s", (_label, a, b, expected) => {
    expect(companyMatches(a, b)).toBe(expected);
  });
});

describe("evaluateEmail", () => {
  const app = (overrides: Partial<TrackedApplication>): TrackedApplication => ({
    id: 1,
    title: "Software Engineer",
    company: "Acme",
    status: "applied",
    notes: "",
    ...overrides,
  });
  const mail = (overrides: Partial<GmailEmail>): GmailEmail => ({
    company: "Acme",
    jobTitleGuess: "",
    kind: "reply",
    date: "2026-01-15",
    from: "recruiter@acme.example",
    excerpt: "",
    ...overrides,
  });

  it("skips when no application matches the company at all", () => {
    const result = evaluateEmail(mail({ company: "Nobody Corp" }), [app({})]);
    expect(result).toEqual({ outcome: "skip", reason: "no-matching-application" });
  });

  it.each(["approved", "offer", "interview", "rejected"] as const)(
    "status %s is never a candidate - the transition whitelist's untouchable statuses",
    (status) => {
      const result = evaluateEmail(mail({ kind: "reply" }), [app({ status })]);
      expect(result).toEqual({ outcome: "skip", reason: "no-eligible-application" });
    },
  );

  it("two eligible applications at the same company is ambiguous, not guessed at", () => {
    const applications = [app({ id: 1, status: "applied" }), app({ id: 2, status: "responded" })];
    const result = evaluateEmail(mail({ kind: "reply" }), applications);
    expect(result).toEqual({ outcome: "skip", reason: "ambiguous-multiple-applications" });
  });

  it("is a no-op when the application is already at the target status", () => {
    const result = evaluateEmail(mail({ kind: "reply" }), [app({ status: "responded" })]);
    expect(result).toMatchObject({ outcome: "skip", reason: "status-already-set" });
  });

  it("moves applied -> responded on a plain reply", () => {
    const result = evaluateEmail(mail({ kind: "reply" }), [app({ status: "applied" })]);
    expect(result).toMatchObject({ outcome: "match", targetStatus: "responded" });
  });

  it("a rejection naming no role still matches the sole application at that company", () => {
    const result = evaluateEmail(mail({ kind: "rejection", jobTitleGuess: "" }), [app({})]);
    expect(result).toMatchObject({ outcome: "match", targetStatus: "rejected" });
  });

  it("a rejection naming an unrelated role is held back (role-mismatch guard)", () => {
    const result = evaluateEmail(mail({ kind: "rejection", jobTitleGuess: "Marketing Intern" }), [
      app({ title: "Backend Engineer" }),
    ]);
    expect(result).toMatchObject({ outcome: "skip", reason: "rejection-role-mismatch" });
  });

  it("sharing only generic words ('ingenieur', 'developpement') is not a role match", () => {
    // Real mailbox case (see the doc comment on titleLikelyMatches): two
    // distinct roles at one employer share only words that appear in half of
    // all engineering job titles.
    const applications = [app({ title: "Ingenieur Developpement Logiciels Embarques" })];
    const result = evaluateEmail(
      mail({ kind: "rejection", jobTitleGuess: "Ingenieur etude et developpement C/C++" }),
      applications,
    );
    expect(result).toMatchObject({ outcome: "skip", reason: "rejection-role-mismatch" });
  });

  it("a rejection plausibly matching two applications at the company is ambiguous", () => {
    const applications = [
      app({ id: 1, status: "applied", title: "DevOps Engineer" }),
      app({ id: 2, status: "interview", title: "DevOps Consultant" }), // ineligible, but still "another role"
    ];
    const result = evaluateEmail(mail({ kind: "rejection", jobTitleGuess: "DevOps" }), applications);
    expect(result).toMatchObject({ outcome: "skip", reason: "rejection-role-ambiguous" });
  });

  it("a rejection that uniquely identifies one of several applications still resolves", () => {
    const applications = [
      app({ id: 1, status: "applied", title: "Backend Engineer" }),
      app({ id: 2, status: "interview", title: "Marketing Manager" }),
    ];
    const result = evaluateEmail(mail({ kind: "rejection", jobTitleGuess: "Backend Engineer" }), applications);
    expect(result).toMatchObject({ outcome: "match", application: applications[0], targetStatus: "rejected" });
  });
});
