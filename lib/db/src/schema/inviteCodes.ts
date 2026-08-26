import { integer, pgTable, text, timestamp } from "drizzle-orm/pg-core";

/**
 * Registration gating for the SaaS beta. Codes are minted out of band with
 * `pnpm run invite` (scripts/src/invite.ts); there is no self-service signup
 * without one, which is the cheapest way to keep the beta at the ~100
 * account size the architecture doc plans for.
 *
 * Unused in self-hosted mode, where registration does not exist.
 */
export const inviteCodesTable = pgTable("invite_codes", {
  code: text("code").primaryKey(),
  note: text("note").notNull().default(""),
  maxUses: integer("max_uses").notNull().default(1),
  usedCount: integer("used_count").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  /** Null means "never expires". */
  expiresAt: timestamp("expires_at", { withTimezone: true }),
});

export type InviteCode = typeof inviteCodesTable.$inferSelect;
export type InsertInviteCode = typeof inviteCodesTable.$inferInsert;
