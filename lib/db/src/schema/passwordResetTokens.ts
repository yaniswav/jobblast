import { index, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { usersTable } from "./users";

/**
 * Single-use password reset tokens (v0.4 G2 lot: pluggable email +
 * docs/SAAS-ARCHITECTURE.md section 2's "Password reset" paragraph). Same
 * shape as `sessions`: the raw token only ever exists in the reset email
 * link and briefly in the browser, the database stores `sha256(token)`, so a
 * leaked dump does not hand over a way to take over an account.
 *
 * `usedAt` (rather than deleting the row on use) is what makes a replayed
 * link fail closed even inside a race - the consuming UPDATE sets it with a
 * `WHERE used_at IS NULL` guard, so two concurrent requests for the same
 * token can never both succeed. Saas only: self-hosted has no login screen
 * and no password to reset.
 */
export const passwordResetTokensTable = pgTable(
  "password_reset_tokens",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => usersTable.id, { onDelete: "cascade" }),
    tokenHash: text("token_hash").notNull().unique(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    // 30-minute TTL from creation (docs/SAAS-ARCHITECTURE.md section 2 -
    // see auth/reset-token.ts).
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    // Null until consumed. Once set, the token is dead even if it has not
    // expired yet - single use, not "usable until the TTL runs out".
    usedAt: timestamp("used_at", { withTimezone: true }),
  },
  (table) => [
    index("password_reset_tokens_user_id_idx").on(table.userId),
    index("password_reset_tokens_expires_at_idx").on(table.expiresAt),
  ],
);

export type PasswordResetToken = typeof passwordResetTokensTable.$inferSelect;
export type InsertPasswordResetToken = typeof passwordResetTokensTable.$inferInsert;
