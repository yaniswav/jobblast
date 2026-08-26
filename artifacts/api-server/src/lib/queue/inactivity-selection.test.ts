import { describe, expect, it } from "vitest";
import {
  decideInactivityAction,
  INACTIVITY_DELETE_AFTER_DAYS,
  INACTIVITY_WARNING_AFTER_DAYS,
  INACTIVITY_WARNING_GRACE_DAYS,
  type InactivityAccount,
} from "./inactivity-selection";

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = new Date("2026-08-26T00:00:00Z");

function daysAgo(days: number): Date {
  return new Date(NOW.getTime() - days * DAY_MS);
}

function account(overrides: Partial<InactivityAccount>): InactivityAccount {
  return { lastSeenAt: daysAgo(0), createdAt: daysAgo(400), inactivityWarningSentAt: null, ...overrides };
}

describe("decideInactivityAction - fail-safe", () => {
  it("never warns, however inactive, when the email transport is not enabled", () => {
    const veryInactive = account({ lastSeenAt: daysAgo(500) });
    expect(decideInactivityAction(veryInactive, NOW, false)).toBe("none");
  });

  it("never deletes, however inactive and already warned, when the email transport is not enabled", () => {
    const eligible = account({
      lastSeenAt: daysAgo(INACTIVITY_DELETE_AFTER_DAYS + 5),
      inactivityWarningSentAt: daysAgo(INACTIVITY_WARNING_GRACE_DAYS + 5),
    });
    expect(decideInactivityAction(eligible, NOW, false)).toBe("none");
  });
});

describe("decideInactivityAction - the 11-month warning", () => {
  it("does nothing for a recently active account", () => {
    expect(decideInactivityAction(account({ lastSeenAt: daysAgo(10) }), NOW, true)).toBe("none");
  });

  it("does not warn just under 11 months of inactivity", () => {
    const justUnder = account({ lastSeenAt: daysAgo(INACTIVITY_WARNING_AFTER_DAYS - 1) });
    expect(decideInactivityAction(justUnder, NOW, true)).toBe("none");
  });

  it("warns exactly at 11 months of inactivity (inclusive boundary)", () => {
    const atBoundary = account({ lastSeenAt: daysAgo(INACTIVITY_WARNING_AFTER_DAYS) });
    expect(decideInactivityAction(atBoundary, NOW, true)).toBe("warn");
  });

  it("warns well past 11 months, as long as no warning has been sent yet", () => {
    expect(decideInactivityAction(account({ lastSeenAt: daysAgo(400) }), NOW, true)).toBe("warn");
  });

  it("falls back to createdAt when the account has never signed in", () => {
    const neverSignedIn = account({ lastSeenAt: null, createdAt: daysAgo(INACTIVITY_WARNING_AFTER_DAYS + 1) });
    expect(decideInactivityAction(neverSignedIn, NOW, true)).toBe("warn");
  });

  it("does not warn twice: an account already warned this stretch stays at none until eligible to delete", () => {
    const alreadyWarned = account({
      lastSeenAt: daysAgo(INACTIVITY_WARNING_AFTER_DAYS + 2),
      inactivityWarningSentAt: daysAgo(1),
    });
    expect(decideInactivityAction(alreadyWarned, NOW, true)).toBe("none");
  });
});

describe("decideInactivityAction - the 12-month + 30-day-grace deletion", () => {
  it("does not delete before 12 months of inactivity, even if warned long ago", () => {
    const notOldEnough = account({
      lastSeenAt: daysAgo(INACTIVITY_DELETE_AFTER_DAYS - 1),
      inactivityWarningSentAt: daysAgo(INACTIVITY_WARNING_GRACE_DAYS + 10),
    });
    expect(decideInactivityAction(notOldEnough, NOW, true)).toBe("none");
  });

  it("does not delete before the 30-day grace period has passed, even past 12 months", () => {
    const graceNotOver = account({
      lastSeenAt: daysAgo(INACTIVITY_DELETE_AFTER_DAYS + 5),
      inactivityWarningSentAt: daysAgo(INACTIVITY_WARNING_GRACE_DAYS - 1),
    });
    expect(decideInactivityAction(graceNotOver, NOW, true)).toBe("none");
  });

  it("never deletes an account that was never warned, however inactive", () => {
    const neverWarned = account({ lastSeenAt: daysAgo(INACTIVITY_DELETE_AFTER_DAYS + 100) });
    expect(decideInactivityAction(neverWarned, NOW, true)).toBe("warn");
  });

  it("deletes once both 12 months have elapsed and the warning grace period is over", () => {
    const eligible = account({
      lastSeenAt: daysAgo(INACTIVITY_DELETE_AFTER_DAYS + 1),
      inactivityWarningSentAt: daysAgo(INACTIVITY_WARNING_GRACE_DAYS),
    });
    expect(decideInactivityAction(eligible, NOW, true)).toBe("delete");
  });

  it("clears back to none (via touchUserLastSeen) once the account signs back in - modeled here as inactivityWarningSentAt: null", () => {
    const cameBack = account({ lastSeenAt: daysAgo(0), inactivityWarningSentAt: null });
    expect(decideInactivityAction(cameBack, NOW, true)).toBe("none");
  });
});
