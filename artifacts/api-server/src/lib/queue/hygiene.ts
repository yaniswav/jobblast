// The impure shell around lib/queue/hygiene-selection.ts: two daily,
// platform-wide SQL DELETEs (docs/SAAS-ARCHITECTURE.md section 8 / the v0.4
// pre-beta lot's E5 step). Dispatched from lib/queue/handlers.ts as the
// "sessions.sweep" and "postings.prune" job kinds, enqueued once a day by
// lib/queue/worker.ts.
//
// Both do their filtering in SQL rather than loading rows into JS and
// applying lib/queue/hygiene-selection.ts's predicates by hand - at
// hundreds of thousands of rows the DELETE ... WHERE is the only version of
// this that scales, and hygiene-selection.test.ts is what proves the SQL
// below matches the same logic.
//
// selfhosted never runs these: the queue worker itself is saas-only
// (src/index.ts only calls startQueueWorker() when IS_SAAS). selfhosted also
// never creates a session row at all (no login screen, the local user is
// injected directly - see lib/auth/middleware.ts), so there would be nothing
// for a self-hosted sweep to do even if one ran.

import { and, eq, lt, notExists, sql } from "drizzle-orm";
import { db, postingsTable, sessionsTable, userPostingsTable } from "@workspace/db";
import { logger } from "../logger";
import { POSTING_RETENTION_DAYS_DEFAULT } from "./hygiene-selection";

function postingRetentionDays(): number {
  const raw = Number(process.env["JOBBLAST_POSTING_RETENTION_DAYS"]);
  return Number.isFinite(raw) && raw > 0 ? raw : POSTING_RETENTION_DAYS_DEFAULT;
}

/** Deletes sessions whose expiry has passed. Returns how many were removed. */
export async function sweepExpiredSessions(now: Date = new Date()): Promise<number> {
  const rows = await db.delete(sessionsTable).where(lt(sessionsTable.expiresAt, now)).returning({ id: sessionsTable.id });
  if (rows.length > 0) logger.info({ count: rows.length }, "Hygiene: swept expired sessions");
  return rows.length;
}

/**
 * Deletes shared postings nobody's queue references, older than the
 * retention window (JOBBLAST_POSTING_RETENTION_DAYS, default 90 days).
 * Returns how many were removed.
 */
export async function prunePostings(
  now: Date = new Date(),
  retentionDays: number = postingRetentionDays(),
): Promise<number> {
  const cutoff = new Date(now.getTime() - retentionDays * 24 * 60 * 60 * 1000);
  const referenced = db
    .select({ one: sql<number>`1` })
    .from(userPostingsTable)
    .where(eq(userPostingsTable.postingId, postingsTable.id));

  const rows = await db
    .delete(postingsTable)
    .where(and(lt(postingsTable.lastSeenAt, cutoff), notExists(referenced)))
    .returning({ id: postingsTable.id });
  if (rows.length > 0) {
    logger.info({ count: rows.length, retentionDays }, "Hygiene: pruned unreferenced postings");
  }
  return rows.length;
}
