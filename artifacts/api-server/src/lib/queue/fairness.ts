// Which pending jobs get to run next, and when a failed one is tried again.
//
// Both decisions are pure functions over explicit inputs, deliberately: they
// are the two places where the queue can be unfair or can hammer a broken
// provider, and neither is worth a database to test (see the test strategy in
// docs/SAAS-ARCHITECTURE.md section 9). The impure shell around them -
// locking rows, writing statuses - lives in lib/queue/store.ts and stays thin
// enough to read.
//
// The property that matters, in the doc's words: "a user with 200 queued
// letters cannot starve a user with one". That is what the round-robin below
// buys, together with the per-owner in-flight cap.

/** Owner bucket for platform-wide work, which belongs to no account. */
export const PLATFORM_OWNER = "__platform__";

export type PendingJob = {
  id: number;
  /** null for platform-wide work (a shared source fetch). */
  userId: string | null;
  /** Epoch ms. Jobs that are not due yet must not be passed in. */
  runAt: number;
};

export type FairnessCaps = {
  /** How many more jobs this process can run right now. */
  capacity: number;
  /** How many jobs one owner may have in flight at once. */
  maxPerOwner: number;
};

export function ownerOf(job: { userId: string | null }): string {
  return job.userId ?? PLATFORM_OWNER;
}

/** Fisher-Yates on a copy. Injectable so tests can make the order deterministic. */
export function shuffled<T>(items: readonly T[]): T[] {
  const copy = items.slice();
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j] as T, copy[i] as T];
  }
  return copy;
}

/**
 * Picks up to `caps.capacity` job ids to claim, at most `caps.maxPerOwner`
 * per owner (counting what that owner already has in flight), oldest first
 * within an owner and round-robin across owners.
 *
 * Owners are shuffled before the first round so that a capacity smaller than
 * the number of waiting owners does not always serve the same one. That is
 * the `order by random()` of the claim query sketched in section 6 of the
 * architecture doc, moved somewhere it can be reasoned about.
 */
export function selectNextJobs(
  pending: readonly PendingJob[],
  inFlightByOwner: ReadonlyMap<string, number>,
  caps: FairnessCaps,
  shuffle: <T>(items: readonly T[]) => T[] = shuffled,
): number[] {
  if (caps.capacity <= 0 || caps.maxPerOwner <= 0) return [];

  const byOwner = new Map<string, PendingJob[]>();
  for (const job of pending) {
    const owner = ownerOf(job);
    const bucket = byOwner.get(owner);
    if (bucket) bucket.push(job);
    else byOwner.set(owner, [job]);
  }

  // Oldest first inside an owner, id as the tie-break so the order is total.
  const queues: Array<{ owner: string; jobs: PendingJob[]; slots: number }> = [];
  for (const [owner, jobs] of byOwner) {
    const slots = caps.maxPerOwner - (inFlightByOwner.get(owner) ?? 0);
    if (slots <= 0) continue;
    jobs.sort((a, b) => a.runAt - b.runAt || a.id - b.id);
    queues.push({ owner, jobs, slots });
  }
  if (queues.length === 0) return [];

  const order = shuffle(queues);
  const selected: number[] = [];
  const taken = new Map<string, number>();

  // One pass per round: every owner gets its first job before any owner gets
  // its second, which is the round-robin part.
  for (let round = 0; selected.length < caps.capacity; round++) {
    let progressed = false;
    for (const queue of order) {
      if (selected.length >= caps.capacity) break;
      const already = taken.get(queue.owner) ?? 0;
      if (already >= queue.slots) continue;
      const job = queue.jobs[round];
      if (!job) continue;
      selected.push(job.id);
      taken.set(queue.owner, already + 1);
      progressed = true;
    }
    if (!progressed) break;
  }

  return selected;
}

// ---------------------------------------------------------------------------
// Retry policy
// ---------------------------------------------------------------------------

/** First retry delay. Long enough that a rate-limited provider gets a breather. */
export const RETRY_BASE_MS = 30_000;
/** Ceiling, so the third attempt at a broken key is not scheduled hours out. */
export const RETRY_MAX_MS = 15 * 60_000;

/**
 * How long to wait before attempt number `attempts + 1`, given how many
 * attempts have already been made. Exponential, capped, deterministic: one
 * process claims jobs here, so there is no thundering herd to jitter away.
 */
export function retryDelayMs(attempts: number): number {
  const exponent = Math.max(0, attempts - 1);
  const delay = RETRY_BASE_MS * 2 ** Math.min(exponent, 20);
  return Math.min(delay, RETRY_MAX_MS);
}

/** Whether a job that just failed still has an attempt left. */
export function shouldRetry(attempts: number, maxAttempts: number): boolean {
  return attempts < maxAttempts;
}
