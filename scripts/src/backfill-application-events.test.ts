import { describe, expect, it } from "vitest";
import {
  backfillEventKey,
  computeBackfillInserts,
  type BackfillApplicationRow,
} from "./backfill-application-events";

function application(overrides: Partial<BackfillApplicationRow> = {}): BackfillApplicationRow {
  return {
    id: 1,
    userId: "user-1",
    appliedAt: new Date("2026-01-10T09:00:00Z"),
    lastFollowedUpAt: null,
    followUpCount: 0,
    ...overrides,
  };
}

describe("backfillEventKey", () => {
  it("combines applicationId and kind", () => {
    expect(backfillEventKey(42, "applied")).toBe("42:applied");
  });

  it("distinguishes different applications and different kinds", () => {
    expect(backfillEventKey(1, "applied")).not.toBe(backfillEventKey(2, "applied"));
    expect(backfillEventKey(1, "applied")).not.toBe(backfillEventKey(1, "followed_up"));
  });
});

describe("computeBackfillInserts", () => {
  it("inserts one applied event, dated to appliedAt, for a row never followed up", () => {
    const app = application({ id: 1, appliedAt: new Date("2026-01-10T09:00:00Z") });
    const inserts = computeBackfillInserts([app], new Set());

    expect(inserts).toEqual([
      {
        userId: "user-1",
        applicationId: 1,
        kind: "applied",
        occurredAt: new Date("2026-01-10T09:00:00Z"),
        payload: { origin: "backfill" },
      },
    ]);
  });

  it("also inserts a followed_up event, dated to lastFollowedUpAt, when set", () => {
    const app = application({
      id: 2,
      appliedAt: new Date("2026-01-01T00:00:00Z"),
      lastFollowedUpAt: new Date("2026-01-08T00:00:00Z"),
      followUpCount: 1,
    });
    const inserts = computeBackfillInserts([app], new Set());

    expect(inserts).toHaveLength(2);
    expect(inserts[1]).toEqual({
      userId: "user-1",
      applicationId: 2,
      kind: "followed_up",
      occurredAt: new Date("2026-01-08T00:00:00Z"),
      payload: { origin: "backfill", followUpCount: 1 },
    });
  });

  it("skips the applied event for a row that already has one (idempotent re-run)", () => {
    const app = application({ id: 3 });
    const inserts = computeBackfillInserts([app], new Set([backfillEventKey(3, "applied")]));
    expect(inserts).toEqual([]);
  });

  it("skips only the followed_up event when just that one already exists", () => {
    const app = application({
      id: 4,
      lastFollowedUpAt: new Date("2026-02-01T00:00:00Z"),
      followUpCount: 1,
    });
    const inserts = computeBackfillInserts([app], new Set([backfillEventKey(4, "followed_up")]));
    expect(inserts).toEqual([
      {
        userId: "user-1",
        applicationId: 4,
        kind: "applied",
        occurredAt: app.appliedAt,
        payload: { origin: "backfill" },
      },
    ]);
  });

  it("produces nothing at all once both events already exist", () => {
    const app = application({ id: 5, lastFollowedUpAt: new Date("2026-02-01T00:00:00Z") });
    const existing = new Set([backfillEventKey(5, "applied"), backfillEventKey(5, "followed_up")]);
    expect(computeBackfillInserts([app], existing)).toEqual([]);
  });

  it("handles a mix of several applications independently", () => {
    const neverFollowedUp = application({ id: 10 });
    const followedUp = application({
      id: 11,
      lastFollowedUpAt: new Date("2026-03-01T00:00:00Z"),
      followUpCount: 2,
    });
    const alreadyBackfilled = application({ id: 12 });

    const inserts = computeBackfillInserts(
      [neverFollowedUp, followedUp, alreadyBackfilled],
      new Set([backfillEventKey(12, "applied")]),
    );

    expect(inserts.map((insert) => `${insert.applicationId}:${insert.kind}`)).toEqual([
      "10:applied",
      "11:applied",
      "11:followed_up",
    ]);
  });

  it("returns an empty array for an empty input", () => {
    expect(computeBackfillInserts([], new Set())).toEqual([]);
  });
});
