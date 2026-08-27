// One-time, idempotent backfill for the `application_events` table (lot I1).
// Run it AFTER `pnpm run db:push` has created the table (an additive-only
// migration - see lib/db/src/schema/applicationEvents.ts) and AFTER taking a
// database backup, per this lot's own rollout notes.
//
//   pnpm run backfill-application-events -- --dry-run   report only
//   pnpm run backfill-application-events                apply
//
// What it does: for every existing `applications` row, inserts one "applied"
// event dated to that row's `appliedAt`, and one "followed_up" event dated
// to `lastFollowedUpAt` when that column is set. Best effort, exactly as the
// lot's rollout notes ask for: `followUpCount` can be 2 while only the LAST
// follow-up's timestamp survived on the row, so a row followed up more than
// once before this lot only gets its most recent follow-up timelined, not
// the earlier ones - there is nothing on `applications` to reconstruct them
// from. Safe to run more than once: `existingEventKeys` is read fresh every
// run, so nothing already on a timeline is inserted a second time.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const currentDir = path.dirname(fileURLToPath(import.meta.url));
// scripts/src -> scripts -> repo root
const REPO_ROOT = path.resolve(currentDir, "../..");

// Same reason as scripts/src/migrate-multi-tenant.ts and catalog-candidates.ts:
// nothing loads the repo-root .env for a plain `tsx` process.
if (!process.env["DATABASE_URL"]) {
  const envFile = path.join(REPO_ROOT, ".env");
  if (fs.existsSync(envFile)) {
    for (const line of fs.readFileSync(envFile, "utf8").split(/\r?\n/)) {
      const match = /^\s*([\w.-]+)\s*=\s*(.*?)\s*$/.exec(line);
      if (match?.[1] && !process.env[match[1]]) {
        process.env[match[1]] = match[2]!.replace(/^["']|["']$/g, "");
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Pure core - no I/O, no clock. Covered by backfill-application-events.test.ts.
// ---------------------------------------------------------------------------

export type BackfillApplicationRow = {
  id: number;
  userId: string;
  appliedAt: Date;
  lastFollowedUpAt: Date | null;
  followUpCount: number;
};

export type BackfillEventInsert = {
  userId: string;
  applicationId: number;
  kind: "applied" | "followed_up";
  occurredAt: Date;
  payload: Record<string, unknown>;
};

/** One (applicationId, kind) pair's identity in `existingEventKeys` below. */
export function backfillEventKey(applicationId: number, kind: string): string {
  return `${applicationId}:${kind}`;
}

/**
 * What this script backfills: one "applied" event per application (dated to
 * its original `appliedAt`), plus one "followed_up" event for a row that has
 * `lastFollowedUpAt` set. `existingEventKeys` is everything already on a
 * timeline (any origin, not just a prior backfill run - a row created after
 * lot I1 shipped already got its "applied" event written live, and must not
 * get a second one here), which is what makes re-running this script a
 * no-op the second time. Pure and deterministic: same input, same output.
 */
export function computeBackfillInserts(
  applications: readonly BackfillApplicationRow[],
  existingEventKeys: ReadonlySet<string>,
): BackfillEventInsert[] {
  const inserts: BackfillEventInsert[] = [];

  for (const application of applications) {
    if (!existingEventKeys.has(backfillEventKey(application.id, "applied"))) {
      inserts.push({
        userId: application.userId,
        applicationId: application.id,
        kind: "applied",
        occurredAt: application.appliedAt,
        payload: { origin: "backfill" },
      });
    }

    if (
      application.lastFollowedUpAt &&
      !existingEventKeys.has(backfillEventKey(application.id, "followed_up"))
    ) {
      inserts.push({
        userId: application.userId,
        applicationId: application.id,
        kind: "followed_up",
        occurredAt: application.lastFollowedUpAt,
        payload: { origin: "backfill", followUpCount: application.followUpCount },
      });
    }
  }

  return inserts;
}

// ---------------------------------------------------------------------------
// I/O
// ---------------------------------------------------------------------------

type ApplicationsQueryRow = {
  id: number;
  user_id: string;
  applied_at: Date;
  last_followed_up_at: Date | null;
  follow_up_count: number;
};

type ExistingEventQueryRow = { application_id: number; kind: string };

async function main(): Promise<void> {
  const dryRun = process.argv.includes("--dry-run");
  const { pool } = await import("@workspace/db");

  try {
    const { rows: applicationRows } = await pool.query<ApplicationsQueryRow>(
      "select id, user_id, applied_at, last_followed_up_at, follow_up_count from applications order by id",
    );
    const applications: BackfillApplicationRow[] = applicationRows.map((row) => ({
      id: row.id,
      userId: row.user_id,
      appliedAt: row.applied_at,
      lastFollowedUpAt: row.last_followed_up_at,
      followUpCount: row.follow_up_count,
    }));

    const { rows: eventRows } = await pool.query<ExistingEventQueryRow>(
      "select distinct application_id, kind from application_events where kind in ('applied', 'followed_up')",
    );
    const existingEventKeys = new Set(
      eventRows.map((row) => backfillEventKey(row.application_id, row.kind)),
    );

    const inserts = computeBackfillInserts(applications, existingEventKeys);
    const appliedCount = inserts.filter((insert) => insert.kind === "applied").length;
    const followedUpCount = inserts.filter((insert) => insert.kind === "followed_up").length;

    console.log(
      `${applications.length} application(s) scanned - ${appliedCount} "applied" and ${followedUpCount} "followed_up" event(s) to insert` +
        (dryRun ? " (dry run: nothing written)" : ""),
    );

    if (inserts.length === 0) {
      console.log("Nothing to do.");
      return;
    }
    if (dryRun) return;

    const client = await pool.connect();
    try {
      await client.query("begin");
      for (const insert of inserts) {
        await client.query(
          "insert into application_events (user_id, application_id, kind, occurred_at, payload) values ($1, $2, $3, $4, $5::jsonb)",
          [insert.userId, insert.applicationId, insert.kind, insert.occurredAt, JSON.stringify(insert.payload)],
        );
      }
      await client.query("commit");
      console.log(`Inserted ${inserts.length} backfilled event(s).`);
    } catch (err) {
      await client.query("rollback").catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  } finally {
    await pool.end();
  }
}

// Only auto-run when this file is the process entry point (`tsx
// ./src/backfill-application-events.ts`), not when the test file imports its
// pure functions.
const isMainModule = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMainModule) {
  await main();
}
