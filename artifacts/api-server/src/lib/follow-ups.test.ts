import { describe, expect, it } from "vitest";
import {
  daysSince,
  followUpDueAt,
  isFollowUpEligible,
  MAX_SUGGESTED_FOLLOW_UPS,
  selectFollowUpCandidates,
  type FollowUpCandidate,
} from "./follow-ups";

const DAY_MS = 24 * 60 * 60 * 1000;
const AFTER_DAYS = 7;

function candidate(overrides: Partial<FollowUpCandidate> = {}): FollowUpCandidate {
  return {
    status: "applied",
    appliedAt: new Date("2026-08-01T09:00:00Z"),
    lastFollowedUpAt: null,
    followUpCount: 0,
    ...overrides,
  };
}

describe("daysSince", () => {
  it("counts whole days elapsed", () => {
    const from = new Date("2026-08-01T09:00:00Z");
    const now = new Date("2026-08-14T09:00:00Z");
    expect(daysSince(from, now)).toBe(13);
  });

  it("floors a partial day", () => {
    const from = new Date("2026-08-01T09:00:00Z");
    const now = new Date("2026-08-08T08:00:00Z"); // 6 days 23 hours
    expect(daysSince(from, now)).toBe(6);
  });

  it("never goes negative", () => {
    const from = new Date("2026-08-10T00:00:00Z");
    const now = new Date("2026-08-01T00:00:00Z");
    expect(daysSince(from, now)).toBe(0);
  });
});

describe("followUpDueAt", () => {
  it("is appliedAt + afterDays for a row never followed up", () => {
    const application = candidate({ appliedAt: new Date("2026-08-01T09:00:00Z") });
    expect(followUpDueAt(application, 7).toISOString()).toBe(new Date("2026-08-08T09:00:00Z").toISOString());
  });

  it("is lastFollowedUpAt + afterDays once a follow-up has happened, ignoring appliedAt", () => {
    const application = candidate({
      appliedAt: new Date("2026-08-01T09:00:00Z"),
      lastFollowedUpAt: new Date("2026-08-10T09:00:00Z"),
    });
    expect(followUpDueAt(application, 7).toISOString()).toBe(new Date("2026-08-17T09:00:00Z").toISOString());
  });
});

describe("isFollowUpEligible", () => {
  it("is eligible once appliedAt is at least afterDays in the past", () => {
    const appliedAt = new Date("2026-08-01T09:00:00Z");
    const now = new Date(appliedAt.getTime() + AFTER_DAYS * DAY_MS);
    expect(isFollowUpEligible(candidate({ appliedAt }), now, AFTER_DAYS)).toBe(true);
  });

  it("is not eligible before afterDays has elapsed (this repo's Thales case: J+6)", () => {
    const appliedAt = new Date("2026-08-01T09:00:00Z");
    const now = new Date(appliedAt.getTime() + 6 * DAY_MS);
    expect(isFollowUpEligible(candidate({ appliedAt }), now, AFTER_DAYS)).toBe(false);
  });

  it("is eligible past the threshold (J+13 vs a 7-day setting)", () => {
    const appliedAt = new Date("2026-08-01T09:00:00Z");
    const now = new Date(appliedAt.getTime() + 13 * DAY_MS);
    expect(isFollowUpEligible(candidate({ appliedAt }), now, AFTER_DAYS)).toBe(true);
  });

  it.each(["approved", "responded", "interview", "rejected", "offer"])(
    "excludes status %s even when long overdue",
    (status) => {
      const appliedAt = new Date("2026-01-01T00:00:00Z");
      const now = new Date("2026-08-01T00:00:00Z");
      expect(isFollowUpEligible(candidate({ status, appliedAt }), now, AFTER_DAYS)).toBe(false);
    },
  );

  it("resuggests after a new afterDays window once a prior follow-up was recorded", () => {
    const lastFollowedUpAt = new Date("2026-08-01T09:00:00Z");
    const application = candidate({
      appliedAt: new Date("2026-07-01T09:00:00Z"),
      lastFollowedUpAt,
      followUpCount: 1,
    });
    const tooSoon = new Date(lastFollowedUpAt.getTime() + 3 * DAY_MS);
    const dueAgain = new Date(lastFollowedUpAt.getTime() + AFTER_DAYS * DAY_MS);
    expect(isFollowUpEligible(application, tooSoon, AFTER_DAYS)).toBe(false);
    expect(isFollowUpEligible(application, dueAgain, AFTER_DAYS)).toBe(true);
  });

  it("caps suggestions at MAX_SUGGESTED_FOLLOW_UPS, however overdue", () => {
    expect(MAX_SUGGESTED_FOLLOW_UPS).toBe(2);
    const longOverdue = candidate({
      appliedAt: new Date("2025-01-01T00:00:00Z"),
      lastFollowedUpAt: new Date("2025-06-01T00:00:00Z"),
      followUpCount: MAX_SUGGESTED_FOLLOW_UPS,
    });
    const now = new Date("2026-08-01T00:00:00Z");
    expect(isFollowUpEligible(longOverdue, now, AFTER_DAYS)).toBe(false);
  });

  it("is still eligible one below the cap", () => {
    const application = candidate({
      appliedAt: new Date("2026-07-01T00:00:00Z"),
      lastFollowedUpAt: new Date("2026-07-10T00:00:00Z"),
      followUpCount: MAX_SUGGESTED_FOLLOW_UPS - 1,
    });
    const now = new Date(application.lastFollowedUpAt!.getTime() + AFTER_DAYS * DAY_MS);
    expect(isFollowUpEligible(application, now, AFTER_DAYS)).toBe(true);
  });
});

describe("selectFollowUpCandidates", () => {
  it("returns only the eligible rows, preserving the rest untouched", () => {
    const now = new Date("2026-08-20T00:00:00Z");
    const overdue = candidate({ appliedAt: new Date("2026-08-01T00:00:00Z") });
    const tooRecent = candidate({ appliedAt: new Date("2026-08-19T00:00:00Z") });
    const responded = candidate({ status: "responded", appliedAt: new Date("2026-07-01T00:00:00Z") });
    const cappedOut = candidate({
      appliedAt: new Date("2026-01-01T00:00:00Z"),
      lastFollowedUpAt: new Date("2026-01-15T00:00:00Z"),
      followUpCount: MAX_SUGGESTED_FOLLOW_UPS,
    });

    const result = selectFollowUpCandidates([overdue, tooRecent, responded, cappedOut], now, AFTER_DAYS);
    expect(result).toEqual([overdue]);
  });

  it("returns an empty array when nothing is eligible", () => {
    const now = new Date("2026-08-02T00:00:00Z");
    const tooRecent = candidate({ appliedAt: new Date("2026-08-01T00:00:00Z") });
    expect(selectFollowUpCandidates([tooRecent], now, AFTER_DAYS)).toEqual([]);
  });
});
