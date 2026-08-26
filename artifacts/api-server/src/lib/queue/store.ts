// The impure shell around lib/queue/fairness.ts: rows, locks and statuses.
//
// Everything interesting about this queue - who runs next, and how long a
// failure waits - is a pure function next door. What is left here is the SQL
// that makes those decisions durable, and it is deliberately thin
// (docs/SAAS-ARCHITECTURE.md section 6: "the hand-rolled version is roughly
// 120 lines against a Postgres already running").
//
// Two properties this file is responsible for:
//
//   1. Two workers never run the same job. The claim UPDATE re-checks
//      `status = 'pending'` under `FOR UPDATE SKIP LOCKED`, so a row another
//      transaction already holds is skipped rather than waited on.
//   2. A job left `running` by a crashed process comes back. `locked_at`
//      older than LEASE_MS is reclaimed on the next poll, keeping the
//      attempts it had already spent.
//
// It lives outside src/lib/repo/ on purpose: that layer's contract is "every
// exported function takes the acting account first", and a work queue is
// platform-wide by nature - claiming reads every account's rows at once,
// which is exactly what makes it fair.

import { and, asc, desc, eq, inArray, isNull, lt, lte, sql } from "drizzle-orm";
import { db, jobsTable, type InsertJob, type Job, type JobKind } from "@workspace/db";
import { logger } from "../logger";
import {
  ownerOf,
  retryDelayMs,
  selectNextJobs,
  shouldRetry,
  type FairnessCaps,
  type PendingJob,
} from "./fairness";

/**
 * How long a claimed job may stay `running` before another worker assumes
 * the process holding it died. Comfortably longer than the slowest job kind
 * (a full multi-source refresh), short enough that a crash does not park work
 * for an hour.
 */
const LEASE_MS = 20 * 60 * 1000;

/**
 * How many pending rows the claim query reads before the fairness function
 * chooses among them. Bounded so one account's 200 queued letters cannot
 * turn every poll into a full table scan; ordered by `run_at`, so the oldest
 * work is always inside the window.
 */
const CLAIM_WINDOW = 200;

export type EnqueueInput = {
  kind: JobKind;
  /** null for platform-wide work (a shared source fetch belongs to no account). */
  userId?: string | null;
  payload?: Record<string, unknown>;
  /**
   * Unique among pending rows. Two enqueues with the same key while the first
   * is still waiting collapse into one, which is what keeps an hourly ticker
   * from piling up refreshes behind a slow cycle.
   */
  dedupeKey?: string | null;
  runAt?: Date;
  maxAttempts?: number;
};

/**
 * Adds one job, or does nothing when an identical one is already pending.
 * Returns the row id, or null when it was deduplicated away.
 */
export async function enqueueJob(input: EnqueueInput): Promise<number | null> {
  const values: InsertJob = {
    kind: input.kind,
    userId: input.userId ?? null,
    payload: input.payload ?? {},
    dedupeKey: input.dedupeKey ?? null,
    runAt: input.runAt ?? new Date(),
  };
  if (input.maxAttempts !== undefined) {
    values.maxAttempts = input.maxAttempts;
  }

  // The unique index is partial (`where status = 'pending'`), so the conflict
  // target has to name the same predicate or Postgres cannot match it.
  const [row] = await db
    .insert(jobsTable)
    .values(values)
    .onConflictDoNothing({
      target: jobsTable.dedupeKey,
      // `where` here is the index predicate, not a row filter: it has to
      // repeat the partial index's own condition or Postgres cannot match it.
      where: sql`status = 'pending'`,
    })
    .returning({ id: jobsTable.id });

  return row?.id ?? null;
}

/** Puts jobs left `running` by a dead process back in the pending pool. */
export async function reclaimStaleJobs(): Promise<number> {
  const cutoff = new Date(Date.now() - LEASE_MS);
  const rows = await db
    .update(jobsTable)
    .set({ status: "pending", lockedBy: null, lockedAt: null })
    // `lt` on a null locked_at is null, not true, so a row that is somehow
    // running without a lease is left alone rather than churned every poll.
    .where(and(eq(jobsTable.status, "running"), lt(jobsTable.lockedAt, cutoff)))
    .returning({ id: jobsTable.id });

  if (rows.length > 0) {
    logger.warn({ count: rows.length }, "Queue: reclaimed jobs whose worker never finished them");
  }
  return rows.length;
}

/**
 * Claims up to `caps.capacity` jobs for `workerId`, round-robin across
 * accounts. The window read and the fairness choice are separate from the
 * locking UPDATE on purpose: the choice is a tested pure function, and the
 * UPDATE re-checks `status = 'pending'` so a row that another worker took in
 * between is simply skipped.
 */
export async function claimJobs(workerId: string, caps: FairnessCaps): Promise<Job[]> {
  if (caps.capacity <= 0) return [];

  const window = await db
    .select({ id: jobsTable.id, userId: jobsTable.userId, runAt: jobsTable.runAt })
    .from(jobsTable)
    .where(and(eq(jobsTable.status, "pending"), lte(jobsTable.runAt, new Date())))
    .orderBy(asc(jobsTable.runAt), asc(jobsTable.id))
    .limit(CLAIM_WINDOW);
  if (window.length === 0) return [];

  const running = await db
    .select({ userId: jobsTable.userId, count: sql<number>`count(*)::int` })
    .from(jobsTable)
    .where(eq(jobsTable.status, "running"))
    .groupBy(jobsTable.userId);

  const inFlight = new Map<string, number>();
  for (const row of running) inFlight.set(ownerOf(row), row.count);

  const pending: PendingJob[] = window.map((row) => ({
    id: row.id,
    userId: row.userId,
    runAt: row.runAt.getTime(),
  }));

  const chosen = selectNextJobs(pending, inFlight, caps);
  if (chosen.length === 0) return [];

  const claimable = db
    .select({ id: jobsTable.id })
    .from(jobsTable)
    .where(and(inArray(jobsTable.id, chosen), eq(jobsTable.status, "pending")))
    .for("update", { skipLocked: true });

  return db
    .update(jobsTable)
    .set({
      status: "running",
      lockedBy: workerId,
      lockedAt: new Date(),
      attempts: sql`${jobsTable.attempts} + 1`,
    })
    .where(inArray(jobsTable.id, claimable))
    .returning();
}

export async function completeJob(id: number): Promise<void> {
  await db
    .update(jobsTable)
    .set({ status: "done", finishedAt: new Date(), lastError: null, lockedBy: null, lockedAt: null })
    .where(eq(jobsTable.id, id));
}

/**
 * Records a failure: back to `pending` with a backoff delay while attempts
 * remain, `failed` once they are spent. `attempts` is what the claim already
 * incremented, so it counts the attempt that just failed.
 */
export async function failJob(job: Job, error: string): Promise<{ retrying: boolean }> {
  const message = error.slice(0, 2000);
  const retrying = shouldRetry(job.attempts, job.maxAttempts);

  if (retrying) {
    await db
      .update(jobsTable)
      .set({
        status: "pending",
        runAt: new Date(Date.now() + retryDelayMs(job.attempts)),
        lastError: message,
        lockedBy: null,
        lockedAt: null,
      })
      .where(eq(jobsTable.id, job.id));
  } else {
    await db
      .update(jobsTable)
      .set({
        status: "failed",
        finishedAt: new Date(),
        lastError: message,
        lockedBy: null,
        lockedAt: null,
      })
      .where(eq(jobsTable.id, job.id));
  }

  return { retrying };
}

export type JobStatusSummary = {
  id: number;
  kind: string;
  status: string;
  attempts: number;
  lastError: string | null;
  runAt: Date;
  finishedAt: Date | null;
};

/**
 * The most recent job of one kind for one account, for a "your letter is
 * being written" indicator. Scoped by `userId` like everything a route can
 * reach.
 */
export async function latestJobFor(
  userId: string,
  kind: JobKind,
  dedupeKey: string,
): Promise<JobStatusSummary | null> {
  const [row] = await db
    .select({
      id: jobsTable.id,
      kind: jobsTable.kind,
      status: jobsTable.status,
      attempts: jobsTable.attempts,
      lastError: jobsTable.lastError,
      runAt: jobsTable.runAt,
      finishedAt: jobsTable.finishedAt,
    })
    .from(jobsTable)
    .where(
      and(
        eq(jobsTable.userId, userId),
        eq(jobsTable.kind, kind),
        eq(jobsTable.dedupeKey, dedupeKey),
      ),
    )
    .orderBy(desc(jobsTable.id))
    .limit(1);
  return row ?? null;
}

/**
 * Scrubs one account id out of every pending platform-wide job's payload
 * (G2 lot, a bug found in G1): `postings.refresh` is `user_id`-less by
 * design (docs/SAAS-ARCHITECTURE.md section 6 - one fetch, many accounts),
 * so the accounts waiting on it live only in `payload.subscribers`, a plain
 * jsonb array with no FK. Deleting an account therefore does not cascade out
 * of that array the way it cascades out of every real `user_id` column, and
 * a stale subscriber id left behind used to fail the whole job at
 * `user.score` enqueue time (a FK violation on a `user_id` that no longer
 * exists), taking every *other* subscriber's scoring pass down with it -
 * see lib/queue/handlers.ts's runRefresh() doc comment for the second half
 * of this fix (tolerating a subscriber id that slips through anyway).
 *
 * A job left with no subscriber at all is deleted outright rather than kept
 * pending with an empty list, which `readSubscribers()` would reject forever
 * until its attempts ran out. Called from lib/auth/store.ts's
 * deleteAccountCompletely() before the account row itself goes.
 */
export async function removeUserFromPendingJobs(userId: string): Promise<void> {
  const rows = await db
    .select({ id: jobsTable.id, payload: jobsTable.payload })
    .from(jobsTable)
    .where(and(eq(jobsTable.status, "pending"), isNull(jobsTable.userId)));

  for (const row of rows) {
    const subscribers = row.payload["subscribers"];
    if (!Array.isArray(subscribers) || !subscribers.includes(userId)) continue;

    const remaining = subscribers.filter((id) => id !== userId);
    if (remaining.length === 0) {
      await db.delete(jobsTable).where(eq(jobsTable.id, row.id));
    } else {
      await db
        .update(jobsTable)
        .set({ payload: { ...row.payload, subscribers: remaining } })
        .where(eq(jobsTable.id, row.id));
    }
  }
}

/** Deletes finished rows older than `olderThan`. Called by the daily sweep. */
export async function purgeFinishedJobs(olderThan: Date): Promise<number> {
  const rows = await db
    .delete(jobsTable)
    .where(and(inArray(jobsTable.status, ["done", "failed"]), lt(jobsTable.finishedAt, olderThan)))
    .returning({ id: jobsTable.id });
  return rows.length;
}
