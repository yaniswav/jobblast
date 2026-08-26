import { describe, expect, it } from "vitest";
import { isPrunablePosting, isSessionExpired } from "./hygiene-selection";

describe("isSessionExpired", () => {
  it("is false while the expiry is in the future", () => {
    expect(isSessionExpired(new Date("2026-01-02T00:00:00Z"), new Date("2026-01-01T00:00:00Z"))).toBe(false);
  });

  it("is true the instant the expiry passes (inclusive boundary)", () => {
    const at = new Date("2026-01-01T00:00:00Z");
    expect(isSessionExpired(at, at)).toBe(true);
  });

  it("is true once the expiry is in the past", () => {
    expect(isSessionExpired(new Date("2026-01-01T00:00:00Z"), new Date("2026-01-02T00:00:00Z"))).toBe(true);
  });
});

describe("isPrunablePosting", () => {
  const RETENTION_DAYS = 90;
  const now = new Date("2026-06-01T00:00:00Z");

  it("never prunes a posting with a subscriber, however old", () => {
    const ancient = new Date("2020-01-01T00:00:00Z");
    expect(isPrunablePosting({ lastSeenAt: ancient, hasSubscriber: true }, now, RETENTION_DAYS)).toBe(false);
  });

  it("does not prune an unreferenced posting inside the retention window", () => {
    const recentlySeen = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
    expect(isPrunablePosting({ lastSeenAt: recentlySeen, hasSubscriber: false }, now, RETENTION_DAYS)).toBe(false);
  });

  it("does not prune exactly at the retention boundary", () => {
    const exactlyAtBoundary = new Date(now.getTime() - RETENTION_DAYS * 24 * 60 * 60 * 1000);
    expect(isPrunablePosting({ lastSeenAt: exactlyAtBoundary, hasSubscriber: false }, now, RETENTION_DAYS)).toBe(
      false,
    );
  });

  it("prunes an unreferenced posting older than the retention window", () => {
    const wellPastBoundary = new Date(now.getTime() - (RETENTION_DAYS + 1) * 24 * 60 * 60 * 1000);
    expect(isPrunablePosting({ lastSeenAt: wellPastBoundary, hasSubscriber: false }, now, RETENTION_DAYS)).toBe(
      true,
    );
  });
});
