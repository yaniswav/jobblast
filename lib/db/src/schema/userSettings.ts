import { jsonb, pgTable, timestamp, uuid } from "drizzle-orm/pg-core";
import { usersTable } from "./users";

/**
 * Per-account configuration in SaaS mode. `config` holds exactly the shape
 * jobblast.config.json holds on a self-hosted install and is validated by
 * the same JobBlastConfigSchema - there is no second config schema.
 *
 * Self-hosted never reads this table: its config stays the file on disk,
 * behind the same lib/config-store.ts seam.
 */
export const userSettingsTable = pgTable("user_settings", {
  userId: uuid("user_id")
    .primaryKey()
    .references(() => usersTable.id, { onDelete: "cascade" }),
  config: jsonb("config").notNull().default({}),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export type UserSettings = typeof userSettingsTable.$inferSelect;
export type InsertUserSettings = typeof userSettingsTable.$inferInsert;
