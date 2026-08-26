import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resetConfigCache } from "../config";
import { forgetUserProvider } from "./provider";
import {
  buildFollowUpTemplate,
  generateFollowUpEmail,
  isValidFollowUpEmail,
  wordCount,
  type FollowUpInput,
} from "./follow-up";

let configDir: string;

beforeEach(() => {
  resetConfigCache();
  forgetUserProvider();
  configDir = fs.mkdtempSync(path.join(os.tmpdir(), "jobblast-follow-up-test-"));
});

afterEach(() => {
  resetConfigCache();
  forgetUserProvider();
  delete process.env["JOBBLAST_CONFIG"];
  fs.rmSync(configDir, { recursive: true, force: true });
});

function useConfig(config: Record<string, unknown>): void {
  const file = path.join(configDir, "jobblast.config.json");
  fs.writeFileSync(file, JSON.stringify(config), "utf8");
  process.env["JOBBLAST_CONFIG"] = file;
}

const THALES_FR: FollowUpInput = {
  masterResume: "Ingenieur logiciel embarque, 3 ans d'experience en C++ et systemes temps reel.",
  headline: "Ingenieur logiciel embarque",
  title: "Ingenieur Logiciel Embarque",
  company: "Thales",
  location: "Paris",
  description:
    "Nous recherchons un ingenieur pour rejoindre notre equipe. Vous travaillerez avec notre equipe sur des systemes embarques critiques pour nos clients.",
  appliedAt: new Date("2026-08-13T09:00:00Z"),
  now: new Date("2026-08-26T09:00:00Z"), // 13 days later, matching the app's own vision doc example
};

const ACME_EN: FollowUpInput = {
  masterResume: "Software engineer with 5 years of experience in backend systems and distributed architecture.",
  headline: "Backend engineer",
  title: "Backend Engineer",
  company: "Acme Corp",
  location: "Remote",
  description:
    "We are looking for you to join our team. You will work with our engineering team on distributed systems for our customers.",
  appliedAt: new Date("2026-08-01T09:00:00Z"),
  now: new Date("2026-08-09T09:00:00Z"), // 8 days later
};

describe("buildFollowUpTemplate", () => {
  it("writes in French when the posting is French and French is a listed letter language (the Thales case)", () => {
    useConfig({ candidate: { letterLanguages: ["fr", "en"], fallbackLetterLanguage: "en" } });
    const { subject, body } = buildFollowUpTemplate(THALES_FR);

    expect(subject).toContain("Thales");
    expect(subject).toContain("Ingenieur Logiciel Embarque");
    expect(body).toContain("Bonjour,");
    expect(body).toContain("Cordialement,");
  });

  it("injects the real role, company and elapsed days into the French template", () => {
    useConfig({
      contact: { name: "Yanis E." },
      candidate: { letterLanguages: ["fr"], fallbackLetterLanguage: "fr" },
    });
    const { body } = buildFollowUpTemplate(THALES_FR);

    expect(body).toContain("Ingenieur Logiciel Embarque");
    expect(body).toContain("Thales");
    expect(body).toContain("il y a 13 jours");
    expect(body).toContain("Yanis E.");
  });

  it("writes in English when the posting is English and English is a listed letter language", () => {
    useConfig({ candidate: { letterLanguages: ["fr", "en"], fallbackLetterLanguage: "en" } });
    const { subject, body } = buildFollowUpTemplate(ACME_EN);

    expect(subject).toContain("Acme Corp");
    expect(subject).toContain("Backend Engineer");
    expect(body).toContain("Hello,");
    expect(body).toContain("Best regards,");
    expect(body).toContain("8 days ago");
  });

  it("falls back to the fallback language when the posting matches none of the letter languages", () => {
    // Only French listed, but the posting is in English - nothing to detect,
    // so the template falls back to fallbackLetterLanguage.
    useConfig({ candidate: { letterLanguages: ["fr"], fallbackLetterLanguage: "en" } });
    const { body } = buildFollowUpTemplate(ACME_EN);
    expect(body).toContain("Hello,");
  });

  it("defaults the sign-off to the seed contact name when none is configured", () => {
    useConfig({ candidate: { letterLanguages: ["en"], fallbackLetterLanguage: "en" } });
    const { body } = buildFollowUpTemplate(ACME_EN);
    expect(body.trim().endsWith("Your Name")).toBe(true);
  });

  it("keeps the body inside a reasonable length for a courteous, brief note", () => {
    useConfig({ candidate: { letterLanguages: ["en"], fallbackLetterLanguage: "en" } });
    const { body } = buildFollowUpTemplate(ACME_EN);
    const words = wordCount(body);
    expect(words).toBeGreaterThanOrEqual(60);
    expect(words).toBeLessThanOrEqual(150);
  });
});

describe("generateFollowUpEmail", () => {
  it("falls back to the template, silently, when the account has no AI provider configured", async () => {
    useConfig({ ai: { provider: "none" }, candidate: { letterLanguages: ["fr"], fallbackLetterLanguage: "fr" } });
    const email = await generateFollowUpEmail("test-user", THALES_FR);
    const template = buildFollowUpTemplate(THALES_FR);

    expect(email.source).toBe("template");
    expect(email.subject).toBe(template.subject);
    expect(email.body).toBe(template.body);
  });
});

describe("isValidFollowUpEmail", () => {
  const body100Words = Array.from({ length: 100 }, (_, i) => `word${i}`).join(" ");

  it("accepts a subject and a body within the expected word range", () => {
    expect(isValidFollowUpEmail({ subject: "Following up", body: body100Words })).toBe(true);
  });

  it("rejects a missing or empty subject", () => {
    expect(isValidFollowUpEmail({ subject: "", body: body100Words })).toBe(false);
    expect(isValidFollowUpEmail({ body: body100Words })).toBe(false);
  });

  it("rejects a body that is too short to be a real follow-up", () => {
    expect(isValidFollowUpEmail({ subject: "Following up", body: "Just checking in, thanks." })).toBe(false);
  });

  it("rejects a body that runs far longer than a brief follow-up should", () => {
    const tooLong = Array.from({ length: 400 }, (_, i) => `word${i}`).join(" ");
    expect(isValidFollowUpEmail({ subject: "Following up", body: tooLong })).toBe(false);
  });

  it("rejects a non-object", () => {
    expect(isValidFollowUpEmail("not an object")).toBe(false);
    expect(isValidFollowUpEmail(null)).toBe(false);
  });
});
