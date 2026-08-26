// The two decisions the queue cannot get wrong, tested without a database
// (docs/SAAS-ARCHITECTURE.md section 9's test strategy): who runs next, and
// how long a failure waits.

import { describe, expect, it } from "vitest";
import {
  ownerOf,
  PLATFORM_OWNER,
  retryDelayMs,
  RETRY_BASE_MS,
  RETRY_MAX_MS,
  selectNextJobs,
  shouldRetry,
  type PendingJob,
} from "./fairness";

/** Identity shuffle, so an assertion is about fairness and not about luck. */
const noShuffle = <T>(items: readonly T[]): T[] => items.slice();

function job(id: number, userId: string | null, runAt = id): PendingJob {
  return { id, userId, runAt };
}

describe("selectNextJobs", () => {
  it("gives every waiting account a turn before anyone gets a second one", () => {
    // The doc's own words: "a user with 200 queued letters cannot starve a
    // user with one". Account A asked first and asked a lot; B asked last.
    const pending = [
      job(1, "a", 1),
      job(2, "a", 2),
      job(3, "a", 3),
      job(4, "b", 99),
    ];

    const chosen = selectNextJobs(pending, new Map(), { capacity: 2, maxPerOwner: 4 }, noShuffle);

    expect(chosen).toEqual([1, 4]);
  });

  it("serves an account's own jobs oldest first", () => {
    const pending = [job(7, "a", 300), job(8, "a", 100), job(9, "a", 200)];
    const chosen = selectNextJobs(pending, new Map(), { capacity: 3, maxPerOwner: 3 }, noShuffle);
    expect(chosen).toEqual([8, 9, 7]);
  });

  it("counts what an account already has in flight against its cap", () => {
    const pending = [job(1, "a"), job(2, "b")];
    const inFlight = new Map([["a", 1]]);

    const chosen = selectNextJobs(pending, inFlight, { capacity: 4, maxPerOwner: 1 }, noShuffle);

    // `a` is already running its one allowed job, so only `b` is claimable.
    expect(chosen).toEqual([2]);
  });

  it("never returns more than the capacity", () => {
    const pending = [job(1, "a"), job(2, "b"), job(3, "c"), job(4, "d")];
    const chosen = selectNextJobs(pending, new Map(), { capacity: 2, maxPerOwner: 5 }, noShuffle);
    expect(chosen).toHaveLength(2);
  });

  it("treats platform-wide work as one more owner, not as a free pass", () => {
    // A shared source fetch belongs to no account, so it queues behind the
    // same per-owner cap as everybody else rather than filling the worker.
    const pending = [job(1, null), job(2, null), job(3, "a")];
    const chosen = selectNextJobs(pending, new Map(), { capacity: 3, maxPerOwner: 1 }, noShuffle);

    expect(chosen).toEqual([1, 3]);
    expect(ownerOf({ userId: null })).toBe(PLATFORM_OWNER);
  });

  it("returns nothing when there is no capacity or no allowance", () => {
    const pending = [job(1, "a")];
    expect(selectNextJobs(pending, new Map(), { capacity: 0, maxPerOwner: 1 }, noShuffle)).toEqual([]);
    expect(selectNextJobs(pending, new Map(), { capacity: 1, maxPerOwner: 0 }, noShuffle)).toEqual([]);
    expect(selectNextJobs([], new Map(), { capacity: 5, maxPerOwner: 5 }, noShuffle)).toEqual([]);
  });

  it("rotates which account is served first when capacity is scarce", () => {
    // With capacity below the number of waiting accounts, always taking the
    // same first owner would starve the rest. The shuffle is what stops that,
    // so a reversing "shuffle" must change who gets served.
    const pending = [job(1, "a"), job(2, "b")];
    const reversed = <T,>(items: readonly T[]): T[] => items.slice().reverse();

    expect(selectNextJobs(pending, new Map(), { capacity: 1, maxPerOwner: 1 }, noShuffle)).toEqual([1]);
    expect(selectNextJobs(pending, new Map(), { capacity: 1, maxPerOwner: 1 }, reversed)).toEqual([2]);
  });
});

describe("retryDelayMs", () => {
  it("waits longer after each attempt", () => {
    expect(retryDelayMs(1)).toBe(RETRY_BASE_MS);
    expect(retryDelayMs(2)).toBe(RETRY_BASE_MS * 2);
    expect(retryDelayMs(3)).toBe(RETRY_BASE_MS * 4);
  });

  it("stops growing at the cap, however many attempts have been made", () => {
    expect(retryDelayMs(20)).toBe(RETRY_MAX_MS);
    // Deliberately absurd: the exponent is clamped, so this must not overflow
    // into Infinity and schedule a retry at the end of time.
    expect(retryDelayMs(5000)).toBe(RETRY_MAX_MS);
  });

  it("never returns a negative or zero delay", () => {
    expect(retryDelayMs(0)).toBeGreaterThan(0);
    expect(retryDelayMs(-3)).toBeGreaterThan(0);
  });
});

describe("shouldRetry", () => {
  it("allows exactly maxAttempts tries in total", () => {
    expect(shouldRetry(1, 3)).toBe(true);
    expect(shouldRetry(2, 3)).toBe(true);
    expect(shouldRetry(3, 3)).toBe(false);
    expect(shouldRetry(4, 3)).toBe(false);
  });
});
