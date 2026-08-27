// Query-signature canonicalization, the pure function docs/SAAS-ARCHITECTURE.md
// step E3 asks to be table-tested, because both of its failure modes are
// silent: over-sharing shows an account postings it never asked for,
// under-sharing gives every account its own fetch and blows the polite
// request budget.

import { describe, expect, it } from "vitest";
import { JobBlastConfigSchema } from "../config";
import {
  canonicalize,
  groupBySignature,
  signatureOf,
  sourceQueries,
  PRIVATE_SOURCES,
} from "./signature";

function configWith(sources: Record<string, unknown>) {
  return JobBlastConfigSchema.parse({ sources });
}

/** Only the sources under test, so a default flipping does not break the file. */
const ONLY = (enabled: Record<string, unknown>) => ({
  franceTravail: { enabled: false },
  greenhouse: { enabled: false },
  lever: { enabled: false },
  adzuna: { enabled: false },
  jooble: { enabled: false },
  careerjet: { enabled: false },
  yourator: { enabled: false },
  job104: { enabled: false },
  tokyodev: { enabled: false },
  japandev: { enabled: false },
  himalayas: { enabled: false },
  remoteok: { enabled: false },
  remotive: { enabled: false },
  arbeitnow: { enabled: false },
  notionInbox: { enabled: false },
  aiScout: { enabled: false },
  ...enabled,
});

describe("canonicalize", () => {
  it.each([
    ["object key order does not matter", { a: 1, b: 2 }, { b: 2, a: 1 }],
    ["array order does not matter", ["b", "a"], ["a", "b"]],
    ["duplicates in an array do not matter", ["a", "a", "b"], ["b", "a"]],
    ["surrounding whitespace does not matter", { q: "  c++ " }, { q: "c++" }],
    ["case does not matter", { q: "C++" }, { q: "c++" }],
    ["nesting is normalized too", { a: { z: ["b", "a"] } }, { a: { z: ["a", "b"] } }],
  ])("%s", (_name, left, right) => {
    expect(canonicalize(left)).toBe(canonicalize(right));
  });

  it.each([
    ["different values", { q: "c++" }, { q: "rust" }],
    ["a missing key", { q: "c++", where: "paris" }, { q: "c++" }],
    ["a number is not its string", { limit: 50 }, { limit: "50" }],
    ["an extra array item", ["a"], ["a", "b"]],
  ])("tells apart %s", (_name, left, right) => {
    expect(canonicalize(left)).not.toBe(canonicalize(right));
  });

  it("does not confuse null with the string null", () => {
    expect(canonicalize(null)).not.toBe(canonicalize("null"));
  });
});

describe("signatureOf", () => {
  it("is stable across calls and hex-shaped", () => {
    const first = signatureOf("adzuna", { where: "Paris" });
    expect(signatureOf("adzuna", { where: "paris" })).toBe(first);
    expect(first).toMatch(/^[0-9a-f]{32}$/);
  });

  it("separates the same parameters on two different sources", () => {
    expect(signatureOf("adzuna", { q: "c++" })).not.toBe(signatureOf("remotive", { q: "c++" }));
  });
});

describe("sourceQueries", () => {
  it("only lists the sources the account has enabled", () => {
    const queries = sourceQueries(configWith(ONLY({ remoteok: { enabled: true, tags: ["cplusplus"] } })));
    expect(queries.map((query) => query.source)).toEqual(["remoteok"]);
  });

  it("gives two accounts asking the same thing the same signature", () => {
    const a = sourceQueries(configWith(ONLY({ adzuna: { enabled: true, queries: ["c++", "rust"], where: "Paris" } })));
    const b = sourceQueries(configWith(ONLY({ adzuna: { enabled: true, queries: ["Rust", "C++"], where: " paris " } })));
    expect(a[0]?.signature).toBe(b[0]?.signature);
  });

  it("gives two accounts asking different things different signatures", () => {
    const a = sourceQueries(configWith(ONLY({ adzuna: { enabled: true, where: "Paris" } })));
    const b = sourceQueries(configWith(ONLY({ adzuna: { enabled: true, where: "Lyon" } })));
    expect(a[0]?.signature).not.toBe(b[0]?.signature);
  });

  it("ignores parameters that do not change the request", () => {
    // `name` is a display label on a Greenhouse board; only the slug is in
    // the URL, so two accounts spelling the company differently share a fetch.
    const a = sourceQueries(configWith(ONLY({ greenhouse: { enabled: true, boards: [{ slug: "datadog", name: "Datadog" }] } })));
    const b = sourceQueries(configWith(ONLY({ greenhouse: { enabled: true, boards: [{ slug: "datadog", name: "DataDog Inc" }] } })));
    expect(a[0]?.signature).toBe(b[0]?.signature);
  });

  it("gives a parameterless source one signature for everybody", () => {
    const a = sourceQueries(configWith(ONLY({ arbeitnow: { enabled: true } })));
    const b = sourceQueries(configWith(ONLY({ arbeitnow: { enabled: true } })));
    expect(a[0]?.signature).toBe(b[0]?.signature);
  });
});

describe("sourceQueries: Company Watch keyword targeting (lot J3)", () => {
  function withWatchedWorkday(keywords: string[], boards: string[] = ["thales/wd3/Careers"]) {
    const cfg = JobBlastConfigSchema.parse({
      sources: ONLY({ franceTravail: { enabled: false, keywords } }),
      watchedCompanies: boards.map((board, i) => ({
        id: `w${i}`,
        url: `https://example.com/${board}`,
        ats: "workday",
        board,
        label: board,
      })),
    });
    return cfg;
  }

  function withWatchedAshby(keywords: string[], boards: string[] = ["ramp"]) {
    return JobBlastConfigSchema.parse({
      sources: ONLY({ franceTravail: { enabled: false, keywords } }),
      watchedCompanies: boards.map((board, i) => ({
        id: `a${i}`,
        url: `https://example.com/${board}`,
        ats: "ashby",
        board,
        label: board,
      })),
    });
  }

  it("gives two accounts watching the same Workday board different signatures when their keywords differ", () => {
    const a = sourceQueries(withWatchedWorkday(["c++"]));
    const b = sourceQueries(withWatchedWorkday(["python"]));
    const workdayA = a.find((q) => q.source === "workday");
    const workdayB = b.find((q) => q.source === "workday");
    expect(workdayA?.signature).not.toBe(workdayB?.signature);
  });

  it("gives two accounts watching the same Workday board the same signature when their keywords match (order/case/whitespace-insensitive)", () => {
    const a = sourceQueries(withWatchedWorkday(["c++", "embedded"]));
    const b = sourceQueries(withWatchedWorkday(["Embedded", " C++ "]));
    const workdayA = a.find((q) => q.source === "workday");
    const workdayB = b.find((q) => q.source === "workday");
    expect(workdayA?.signature).toBe(workdayB?.signature);
  });

  it("does the same for SmartRecruiters (the other keyword-targeted ATS)", () => {
    function withWatchedSmartRecruiters(keywords: string[]) {
      return JobBlastConfigSchema.parse({
        sources: ONLY({ franceTravail: { enabled: false, keywords } }),
        watchedCompanies: [
          { id: "s1", url: "https://careers.smartrecruiters.com/Grab", ats: "smartrecruiters", board: "Grab", label: "Grab" },
        ],
      });
    }
    const a = sourceQueries(withWatchedSmartRecruiters(["c++"]));
    const b = sourceQueries(withWatchedSmartRecruiters(["rust"]));
    const srA = a.find((q) => q.source === "smartrecruiters");
    const srB = b.find((q) => q.source === "smartrecruiters");
    expect(srA?.signature).not.toBe(srB?.signature);
  });

  it("does NOT fragment a non-keyword-targeted ATS's signature when only keywords differ", () => {
    // Ashby's fetcher never searches by keyword (lot J3 only covers Workday
    // and SmartRecruiters), so its params must stay just the board list.
    const a = sourceQueries(withWatchedAshby(["c++"]));
    const b = sourceQueries(withWatchedAshby(["python"]));
    const ashbyA = a.find((q) => q.source === "ashby");
    const ashbyB = b.find((q) => q.source === "ashby");
    expect(ashbyA?.signature).toBe(ashbyB?.signature);
  });

  it("keeps a Workday signature stable for two accounts with identical boards and no keywords", () => {
    const a = sourceQueries(withWatchedWorkday([]));
    const b = sourceQueries(withWatchedWorkday([]));
    const workdayA = a.find((q) => q.source === "workday");
    const workdayB = b.find((q) => q.source === "workday");
    expect(workdayA?.signature).toBe(workdayB?.signature);
  });
});

describe("groupBySignature", () => {
  it("collapses identical queries into one fetch with several subscribers", () => {
    const queries = sourceQueries(configWith(ONLY({ arbeitnow: { enabled: true } })));
    const groups = groupBySignature([
      { userId: "user-a", queries },
      { userId: "user-b", queries },
    ]);

    expect(groups).toHaveLength(1);
    expect(groups[0]?.subscribers).toEqual(["user-a", "user-b"]);
  });

  it("keeps different queries as separate fetches", () => {
    const groups = groupBySignature([
      { userId: "user-a", queries: sourceQueries(configWith(ONLY({ adzuna: { enabled: true, where: "Paris" } }))) },
      { userId: "user-b", queries: sourceQueries(configWith(ONLY({ adzuna: { enabled: true, where: "Lyon" } }))) },
    ]);

    expect(groups).toHaveLength(2);
    expect(groups.every((group) => group.subscribers.length === 1)).toBe(true);
  });

  it("never shares a source that reaches into one account's own workspace", () => {
    // Two accounts with an unconfigured Notion Inbox have identical
    // parameters, and must still not be handed each other's inbox.
    const queries = sourceQueries(configWith(ONLY({ notionInbox: { enabled: true } })));
    expect(PRIVATE_SOURCES.has("notionInbox")).toBe(true);

    const groups = groupBySignature([
      { userId: "user-a", queries },
      { userId: "user-b", queries },
    ]);

    expect(groups).toHaveLength(2);
    expect(groups.map((group) => group.subscribers)).toEqual([["user-a"], ["user-b"]]);
  });

  it("does not list the same account twice for one signature", () => {
    const queries = sourceQueries(configWith(ONLY({ arbeitnow: { enabled: true } })));
    const groups = groupBySignature([
      { userId: "user-a", queries },
      { userId: "user-a", queries },
    ]);
    expect(groups[0]?.subscribers).toEqual(["user-a"]);
  });
});
