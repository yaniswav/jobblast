// Pure quota logic (docs/SAAS-ARCHITECTURE.md section 5, "Quotas" - v0.4
// pre-beta lot). BYOK means every AI call costs the account real money, so
// this is checked BEFORE the provider call and never after; the impure shell
// that turns this into an atomic counter lives in lib/repo/usage.ts.
//
// Kept a pure function taking its inputs explicitly, same rationale as
// lib/queue/fairness.ts: it is the one place quota math can be off by one,
// and it is testable without a database.

/** The AI job kinds a daily quota applies to. */
export type UsageKind = "tailor" | "fit" | "brief";

/**
 * The UTC calendar day `now` falls on, as `YYYY-MM-DD`. The bucket a usage
 * counter belongs to - see usage_counters.day (lib/db/src/schema/usageCounters.ts).
 * UTC rather than the account's own timezone: simple, unambiguous, and a
 * quota resetting a few hours off from local midnight is not worth carrying
 * per-account timezone data for.
 */
export function utcDayKey(now: Date): string {
  return now.toISOString().slice(0, 10);
}

/**
 * Whether `used` (the count AFTER the attempt being checked) is still within
 * `cap`. A null cap means unlimited - selfhosted always, saas when an
 * operator explicitly disables a quota (see lib/quota-config.ts) - and short
 * circuits without even looking at `used`.
 */
export function checkQuota(used: number, cap: number | null): boolean {
  if (cap === null) return true;
  return used <= cap;
}
