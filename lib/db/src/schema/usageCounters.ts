import { date, index, integer, pgTable, primaryKey, text, uuid } from "drizzle-orm/pg-core";
import { usersTable } from "./users";

/**
 * Daily per-account AI usage, one row per (account, day, kind)
 * (docs/SAAS-ARCHITECTURE.md section 5, "Quotas"). BYOK means every letter
 * costs the account real money, so this is what the platform checks BEFORE
 * every provider call to protect them from a runaway loop - never after.
 *
 * `day` is a plain date (UTC, see lib/quotas.ts utcDayKey) rather than a
 * timestamp, so "today's count" is a primary-key lookup instead of a range
 * scan, and the day boundary is unambiguous.
 *
 * `kind` is one of the AI job kinds a quota applies to: "tailor" (cover
 * letters), "fit" (fit analysis), "brief" (interview prep briefs - selfhosted
 * only in v0.3/v0.4, since briefs need an agent provider BYOK does not offer,
 * but quota-checked here too for when that changes).
 *
 * selfhosted never writes this table: its caps are unset (see
 * lib/quota-config.ts), so nothing ever calls tryConsumeQuota() there.
 */
export const usageCountersTable = pgTable(
  "usage_counters",
  {
    userId: uuid("user_id")
      .notNull()
      .references(() => usersTable.id, { onDelete: "cascade" }),
    day: date("day", { mode: "string" }).notNull(),
    kind: text("kind").notNull(),
    count: integer("count").notNull().default(0),
  },
  (table) => [
    primaryKey({ columns: [table.userId, table.day, table.kind] }),
    index("usage_counters_user_id_idx").on(table.userId),
  ],
);

export type UsageCounter = typeof usageCountersTable.$inferSelect;
export type InsertUsageCounter = typeof usageCountersTable.$inferInsert;
