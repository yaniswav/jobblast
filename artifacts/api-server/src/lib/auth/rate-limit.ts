// Hand-rolled sliding-window rate limiter for the auth routes (login,
// register). docs/SAAS-ARCHITECTURE.md section 2 calls for
// `express-rate-limit`'s default in-memory store, which v0.3's single
// process needs nothing more than a Map to reproduce - so this stays a
// small dependency-free module instead of a new package.
//
// A true sliding window (a timestamp log per key, filtered on every check)
// rather than a fixed-window counter: a fixed window lets an attacker send
// `limit` requests right at the end of one window and another `limit` right
// at the start of the next, for close to `2x limit` in a short burst. The
// counting logic is a pure function of a clock you pass in, so it is
// testable without mocking timers.

export type RateLimitDecision = { allowed: boolean; retryAfterMs: number };

export type RateLimiter = {
  /** Records one attempt for `key` at `now` and says whether it is allowed. */
  check(key: string, now?: number): RateLimitDecision;
};

/** `limit` attempts per `windowMs`, per key, counted with a real sliding window. */
export function createRateLimiter(windowMs: number, limit: number): RateLimiter {
  const hits = new Map<string, number[]>();

  return {
    check(key: string, now: number = Date.now()): RateLimitDecision {
      const cutoff = now - windowMs;
      const recent = (hits.get(key) ?? []).filter((t) => t > cutoff);

      if (recent.length >= limit) {
        hits.set(key, recent);
        return { allowed: false, retryAfterMs: Math.max(0, recent[0]! + windowMs - now) };
      }

      recent.push(now);
      hits.set(key, recent);
      return { allowed: true, retryAfterMs: 0 };
    },
  };
}
