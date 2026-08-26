import { describe, expect, it } from "vitest";
import { FIRST_BATCH_WINDOW_MS, isFirstBatchPending } from "./dashboard-status";

const HOUR = 60 * 60 * 1000;

describe("isFirstBatchPending", () => {
  it("is false once the account has any postings, however new the account is", () => {
    const now = new Date("2026-03-01T12:00:00Z");
    expect(
      isFirstBatchPending({ hasAnyPostings: true, accountCreatedAt: now, now }),
    ).toBe(false);
  });

  it("is true for a brand-new account with no postings yet", () => {
    const now = new Date("2026-03-01T12:00:00Z");
    expect(
      isFirstBatchPending({ hasAnyPostings: false, accountCreatedAt: now, now }),
    ).toBe(true);
  });

  it("stays true within the window", () => {
    const created = new Date("2026-03-01T00:00:00Z");
    const now = new Date(created.getTime() + FIRST_BATCH_WINDOW_MS - HOUR);
    expect(
      isFirstBatchPending({ hasAnyPostings: false, accountCreatedAt: created, now }),
    ).toBe(true);
  });

  it("flips to false once the window has elapsed, so a narrow search does not lie forever", () => {
    const created = new Date("2026-03-01T00:00:00Z");
    const now = new Date(created.getTime() + FIRST_BATCH_WINDOW_MS + HOUR);
    expect(
      isFirstBatchPending({ hasAnyPostings: false, accountCreatedAt: created, now }),
    ).toBe(false);
  });

  it("is false exactly at the window boundary (strict less-than)", () => {
    const created = new Date("2026-03-01T00:00:00Z");
    const now = new Date(created.getTime() + FIRST_BATCH_WINDOW_MS);
    expect(
      isFirstBatchPending({ hasAnyPostings: false, accountCreatedAt: created, now }),
    ).toBe(false);
  });
});
