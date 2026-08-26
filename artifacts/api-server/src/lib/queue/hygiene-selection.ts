// Pure predicates behind the two daily hygiene jobs (docs/SAAS-ARCHITECTURE.md
// section 8 / the v0.4 pre-beta lot's E5 step): which sessions are expired,
// and which shared postings are safe to prune. The impure shell that turns
// these into SQL DELETEs lives next door in lib/queue/hygiene.ts - same split
// as lib/queue/fairness.ts / lib/queue/store.ts, for the same reason: this is
// the one place the retention math could be off by one, and it is testable
// without a database.
//
// The real DELETEs do this filtering in SQL, not by loading rows into this
// function - these exist as the spec the SQL has to match, verified once
// here rather than trusted by inspection.

/** Default retention window for the shared postings pool, in days (docs/SAAS-ARCHITECTURE.md section 3.2 / section 8). */
export const POSTING_RETENTION_DAYS_DEFAULT = 90;

/** True once a session's expiry has passed. */
export function isSessionExpired(expiresAt: Date, now: Date): boolean {
  return expiresAt.getTime() <= now.getTime();
}

/**
 * True when a shared posting is safe to delete: nobody's queue references it
 * (`hasSubscriber` is false) AND it has not been seen again since older than
 * `retentionDays` ago. A posting with even one subscriber is never pruned,
 * regardless of age - it is that account's data, not platform noise.
 */
export function isPrunablePosting(
  posting: { lastSeenAt: Date; hasSubscriber: boolean },
  now: Date,
  retentionDays: number,
): boolean {
  if (posting.hasSubscriber) return false;
  const ageMs = now.getTime() - posting.lastSeenAt.getTime();
  return ageMs > retentionDays * 24 * 60 * 60 * 1000;
}
