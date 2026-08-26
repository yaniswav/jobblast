import { describe, expect, it } from "vitest";
import { createRateLimiter } from "./rate-limit";

describe("createRateLimiter", () => {
  it("allows up to the limit, then blocks", () => {
    const limiter = createRateLimiter(1000, 3);
    const now = 10_000;
    expect(limiter.check("a", now).allowed).toBe(true);
    expect(limiter.check("a", now + 1).allowed).toBe(true);
    expect(limiter.check("a", now + 2).allowed).toBe(true);
    const blocked = limiter.check("a", now + 3);
    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfterMs).toBeGreaterThan(0);
  });

  it("tracks each key independently", () => {
    const limiter = createRateLimiter(1000, 1);
    expect(limiter.check("ip-1", 0).allowed).toBe(true);
    expect(limiter.check("ip-2", 0).allowed).toBe(true);
    expect(limiter.check("ip-1", 1).allowed).toBe(false);
    expect(limiter.check("ip-2", 1).allowed).toBe(false);
  });

  it("is a real sliding window: old attempts age out one at a time, not all at once", () => {
    const limiter = createRateLimiter(1000, 2);
    expect(limiter.check("a", 0).allowed).toBe(true);
    expect(limiter.check("a", 500).allowed).toBe(true);
    // Window is full (two hits at t=0 and t=500); still full just before t=0 ages out.
    expect(limiter.check("a", 999).allowed).toBe(false);
    // t=0 has now aged out of the 1000ms window (cutoff = 1001 - 1000 = 1),
    // but t=500 has not, so exactly one more attempt is allowed.
    expect(limiter.check("a", 1001).allowed).toBe(true);
    expect(limiter.check("a", 1001).allowed).toBe(false);
  });

  it("never lets a burst spanning a fixed-window boundary through at more than the limit", () => {
    // The failure mode a fixed window has and a sliding window must not: hit
    // the limit right at the end of one window, then again right at the
    // start of the next, and confirm the *combined* rate over any 1000ms
    // stretch still respects the cap.
    const limiter = createRateLimiter(1000, 3);
    expect(limiter.check("a", 900).allowed).toBe(true);
    expect(limiter.check("a", 950).allowed).toBe(true);
    expect(limiter.check("a", 999).allowed).toBe(true);
    // A fixed-window counter keyed on [0,1000) vs [1000,2000) would reset
    // here and allow 3 more; the sliding window must not.
    expect(limiter.check("a", 1000).allowed).toBe(false);
    expect(limiter.check("a", 1050).allowed).toBe(false);
  });

  it("computes retryAfterMs as the time until the oldest hit in the window expires", () => {
    const limiter = createRateLimiter(1000, 1);
    limiter.check("a", 100);
    const decision = limiter.check("a", 300);
    expect(decision.allowed).toBe(false);
    expect(decision.retryAfterMs).toBe(800); // 100 + 1000 - 300
  });

  it("defaults `now` to the real clock when omitted", () => {
    const limiter = createRateLimiter(60_000, 1);
    expect(limiter.check("a").allowed).toBe(true);
    expect(limiter.check("a").allowed).toBe(false);
  });
});
