import { sql } from "drizzle-orm";
import {
  bigserial,
  index,
  jsonb,
  pgTable,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { usersTable } from "./users";

/**
 * Background work kinds this queue knows how to run
 * (docs/SAAS-ARCHITECTURE.md section 6).
 *
 *   postings.refresh - platform-wide, one per distinct query signature: one
 *                      fetch feeds every account that asked for the same
 *                      thing. `user_id` is null.
 *   user.score       - per account, no AI: score the postings a refresh just
 *                      landed against that account's own scoring config.
 *   user.fit         - per account, one AI call per posting analyzed.
 *   user.tailor      - per account, one AI call: a cover letter, generated
 *                      strictly on demand in saas (never in bulk, since the
 *                      user is paying for it with their own key).
 *   sessions.sweep   - platform-wide, daily: deletes expired session rows
 *                      (v0.4 pre-beta lot, lib/queue/hygiene.ts).
 *   postings.prune   - platform-wide, daily: deletes shared postings with no
 *                      `user_postings` referent, older than the retention
 *                      window (lib/queue/hygiene.ts).
 */
export type JobKind =
  | "postings.refresh"
  | "user.score"
  | "user.fit"
  | "user.tailor"
  | "sessions.sweep"
  | "postings.prune";

export type JobRunStatus = "pending" | "running" | "done" | "failed";

/**
 * The hand-rolled Postgres work queue. No pg-boss: it brings its own schema,
 * its own migrations and its own scheduling model, and does not do the one
 * thing this system actually needs, which is per-account fairness.
 *
 * Claiming is `FOR UPDATE SKIP LOCKED` over a bounded window of pending rows,
 * with the fairness choice made by a pure function
 * (artifacts/api-server/src/lib/queue/fairness.ts) rather than buried in SQL,
 * so "a user with 200 queued letters cannot starve a user with one" is
 * testable without a database.
 *
 * `dedupe_key` is unique among pending rows only: a job that already ran can
 * be enqueued again, but a second identical job cannot pile up behind the
 * first one while it waits.
 */
export const jobsTable = pgTable(
  "jobs",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    kind: text("kind").notNull(),
    // Null for platform-wide work (a shared source fetch belongs to no one
    // account). Every per-account job carries it, so deleting an account
    // cascades its pending work away with it.
    userId: uuid("user_id").references(() => usersTable.id, { onDelete: "cascade" }),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull().default({}),
    dedupeKey: text("dedupe_key"),
    status: text("status").notNull().default("pending"),
    runAt: timestamp("run_at", { withTimezone: true }).notNull().defaultNow(),
    attempts: smallint("attempts").notNull().default(0),
    maxAttempts: smallint("max_attempts").notNull().default(3),
    // Which worker holds the lease, and since when. `locked_at` is what makes
    // a job left behind by a crashed process reclaimable instead of stuck.
    lockedBy: text("locked_by"),
    lockedAt: timestamp("locked_at", { withTimezone: true }),
    lastError: text("last_error"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
  },
  (table) => [
    uniqueIndex("jobs_dedupe_idx")
      .on(table.dedupeKey)
      .where(sql`status = 'pending'`),
    index("jobs_claim_idx")
      .on(table.status, table.runAt)
      .where(sql`status = 'pending'`),
    index("jobs_user_status_idx").on(table.userId, table.status),
  ],
);

export type Job = typeof jobsTable.$inferSelect;
export type InsertJob = typeof jobsTable.$inferInsert;
