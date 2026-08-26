import { index, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { usersTable } from "./users";

/**
 * Opaque server-side sessions (SaaS mode only - self-hosted never issues
 * one). The row is the source of truth, so logout, "sign out everywhere"
 * and account deletion are a DELETE rather than a revocation-list problem.
 *
 * `tokenHash` stores the hex-encoded sha256 of the cookie value, never the
 * value itself, so a leaked dump does not hand over live sessions. (The
 * architecture doc sketches this as `bytea`; hex text carries the same
 * property with none of the driver-level Buffer handling.)
 */
export const sessionsTable = pgTable(
  "sessions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => usersTable.id, { onDelete: "cascade" }),
    tokenHash: text("token_hash").notNull().unique(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    userAgent: text("user_agent"),
    // sha256(ip + salt), for abuse triage only. Goes away with the session.
    ipHash: text("ip_hash"),
  },
  (table) => [
    index("sessions_user_id_idx").on(table.userId),
    index("sessions_expires_at_idx").on(table.expiresAt),
  ],
);

export type Session = typeof sessionsTable.$inferSelect;
export type InsertSession = typeof sessionsTable.$inferInsert;
