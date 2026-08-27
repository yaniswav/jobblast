import { describe, expect, it } from "vitest";
import {
  computeResumeBackfillInserts,
  isRealMasterResume,
  PLACEHOLDER_MASTER_RESUME,
  type BackfillProfileRow,
} from "./backfill-resumes";

function profile(overrides: Partial<BackfillProfileRow> = {}): BackfillProfileRow {
  return { userId: "user-1", masterResume: "Real resume content, years of experience.", ...overrides };
}

describe("isRealMasterResume", () => {
  it("is false for the exact seed placeholder", () => {
    expect(isRealMasterResume(PLACEHOLDER_MASTER_RESUME)).toBe(false);
  });

  it("is false for the placeholder with surrounding whitespace", () => {
    expect(isRealMasterResume(`  ${PLACEHOLDER_MASTER_RESUME}  \n`)).toBe(false);
  });

  it("is false for an empty or blank string", () => {
    expect(isRealMasterResume("")).toBe(false);
    expect(isRealMasterResume("   ")).toBe(false);
  });

  it("is true for real resume content", () => {
    expect(isRealMasterResume("Jane Doe, Senior Engineer with 8 years of experience.")).toBe(true);
  });
});

describe("computeResumeBackfillInserts", () => {
  it("backfills a real resume as a default 'Main' resume", () => {
    const inserts = computeResumeBackfillInserts([profile({ userId: "user-1", masterResume: "Real content." })], new Set());
    expect(inserts).toEqual([{ userId: "user-1", label: "Main", content: "Real content." }]);
  });

  it("skips a profile that still carries the placeholder", () => {
    const inserts = computeResumeBackfillInserts(
      [profile({ userId: "user-1", masterResume: PLACEHOLDER_MASTER_RESUME })],
      new Set(),
    );
    expect(inserts).toEqual([]);
  });

  it("skips an account that already has any resume row (idempotent re-run)", () => {
    const inserts = computeResumeBackfillInserts(
      [profile({ userId: "user-1" })],
      new Set(["user-1"]),
    );
    expect(inserts).toEqual([]);
  });

  it("preserves the master resume content character-for-character", () => {
    const content = "Line one.\nLine two with \"quotes\" and em-dash - test.\n  Trailing spaces.  ";
    const inserts = computeResumeBackfillInserts([profile({ userId: "user-1", masterResume: content })], new Set());
    expect(inserts[0]?.content).toBe(content);
  });

  it("handles a mix of several accounts independently", () => {
    const real = profile({ userId: "user-1", masterResume: "Real content one." });
    const placeholder = profile({ userId: "user-2", masterResume: PLACEHOLDER_MASTER_RESUME });
    const alreadyBackfilled = profile({ userId: "user-3", masterResume: "Real content three." });

    const inserts = computeResumeBackfillInserts(
      [real, placeholder, alreadyBackfilled],
      new Set(["user-3"]),
    );

    expect(inserts).toEqual([{ userId: "user-1", label: "Main", content: "Real content one." }]);
  });

  it("returns an empty array for an empty input", () => {
    expect(computeResumeBackfillInserts([], new Set())).toEqual([]);
  });
});
