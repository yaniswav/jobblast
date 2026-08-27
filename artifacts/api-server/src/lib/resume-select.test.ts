import { describe, expect, it } from "vitest";
import { selectResumeForJob, type SelectableResume } from "./resume-select";

function resume(overrides: Partial<SelectableResume> = {}): SelectableResume {
  return { id: 1, label: "Main", content: "", isDefault: true, ...overrides };
}

const TECH_JOB = {
  title: "Senior Backend Engineer",
  description:
    "We are looking for a backend engineer to build our Node.js and TypeScript services on AWS, with PostgreSQL and Docker experience.",
};

const MARKETING_JOB = {
  title: "Growth Marketing Manager",
  description: "Own our growth marketing and sales funnel, working closely with customer success.",
};

describe("selectResumeForJob", () => {
  it("always returns the single resume, with no scoring at all", () => {
    const onlyResume = resume({ id: 7, label: "Whatever", content: "completely unrelated content" });
    expect(selectResumeForJob([onlyResume], TECH_JOB)).toBe(onlyResume);
  });

  it("picks the resume whose content best overlaps the posting's skill vocabulary", () => {
    const techResume = resume({
      id: 1,
      label: "CDI EN",
      isDefault: false,
      content: "Backend engineer with TypeScript, Node.js, PostgreSQL and Docker experience.",
    });
    const marketingResume = resume({
      id: 2,
      label: "Stage FR",
      isDefault: true,
      content: "Growth marketing and sales professional, customer success background.",
    });

    expect(selectResumeForJob([techResume, marketingResume], TECH_JOB)).toBe(techResume);
    expect(selectResumeForJob([techResume, marketingResume], MARKETING_JOB)).toBe(marketingResume);
  });

  it("weighs a title hit more than a description-only hit", () => {
    // Matches the job title's skill only.
    const titleMatch = resume({
      id: 1,
      label: "Title match",
      isDefault: false,
      content: "Backend engineer.",
    });
    // Matches only a skill mentioned in the description, not the title.
    const descriptionMatch = resume({
      id: 2,
      label: "Description match",
      isDefault: false,
      content: "PostgreSQL specialist.",
    });

    expect(selectResumeForJob([titleMatch, descriptionMatch], TECH_JOB)).toBe(titleMatch);
  });

  it("falls back to the default resume on a tied score", () => {
    const first = resume({ id: 1, label: "First", isDefault: false, content: "React frontend developer." });
    const second = resume({ id: 2, label: "Second", isDefault: true, content: "React frontend developer." });

    expect(selectResumeForJob([first, second], { title: "React Developer", description: "" })).toBe(second);
  });

  it("falls back to the default resume when nothing scores above zero", () => {
    const first = resume({ id: 1, label: "First", isDefault: false, content: "Completely unrelated hobby text." });
    const second = resume({ id: 2, label: "Second", isDefault: true, content: "Also unrelated hobby text." });

    expect(selectResumeForJob([first, second], TECH_JOB)).toBe(second);
  });

  it("falls back to the first resume when a zero-score tie has no default marked", () => {
    const first = resume({ id: 1, label: "First", isDefault: false, content: "Unrelated." });
    const second = resume({ id: 2, label: "Second", isDefault: false, content: "Also unrelated." });

    expect(selectResumeForJob([first, second], TECH_JOB)).toBe(first);
  });

  it("is deterministic across repeated calls with the same input", () => {
    const resumes = [
      resume({ id: 1, label: "A", isDefault: true, content: "React and TypeScript." }),
      resume({ id: 2, label: "B", isDefault: false, content: "Marketing and sales." }),
    ];
    const first = selectResumeForJob(resumes, TECH_JOB);
    const second = selectResumeForJob(resumes, TECH_JOB);
    expect(first).toBe(second);
  });

  it("throws when given no resumes at all - callers must always guarantee at least one", () => {
    expect(() => selectResumeForJob([], TECH_JOB)).toThrow();
  });
});
