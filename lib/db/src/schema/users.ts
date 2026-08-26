import { boolean, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

/**
 * The implicit account a self-hosted install runs as. It is seeded on first
 * boot (see ensureLocalUser in artifacts/api-server/src/lib/auth/store.ts)
 * and injected as the request user by a mode-gated middleware, so routes,
 * repositories and background passes are written once - for the
 * multi-tenant shape - and exercised daily by the self-hosted product.
 */
export const LOCAL_USER_ID = "00000000-0000-0000-0000-000000000001";

export const usersTable = pgTable("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  // Always stored lowercased by the auth layer. A plain unique index stands
  // in for the `citext` column the architecture doc sketches, so a
  // self-hosted Postgres needs no extension installed to run JobBlast.
  email: text("email").notNull().unique(),
  // Empty string for the self-hosted local user: it has no password and can
  // never be logged into, because self-hosted has no login screen at all.
  // verifyPassword() rejects an empty hash outright.
  passwordHash: text("password_hash").notNull(),
  emailVerified: boolean("email_verified").notNull().default(false),
  displayName: text("display_name"),
  locale: text("locale"),
  status: text("status").notNull().default("active"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  lastLoginAt: timestamp("last_login_at", { withTimezone: true }),
  // Inactivity tracking only (v0.4 pre-beta lot): refreshed at most once a
  // day by a resolved session, see lib/auth/store.ts resolveSession(). Not
  // yet acted on - the 12-month auto-purge with a 30-day warning email
  // depends on the SMTP lot (docs/SAAS-ARCHITECTURE.md open question 3) and
  // is intentionally not implemented here.
  lastSeenAt: timestamp("last_seen_at", { withTimezone: true }),
  // G1 onboarding lot: null until the account has been through the onboarding
  // wizard (profile, search criteria, optional BYOK) and pressed "finish".
  // The explicit source of truth for "is this account onboarded" - see
  // lib/onboarding.ts for why a flag beats inferring it from profile/config
  // contents. Self-hosted's local user is seeded with this already set
  // (ensureLocalUser in lib/auth/store.ts), so the onboarding gate - which
  // only ever runs in saas anyway - can never fire there.
  onboardingCompletedAt: timestamp("onboarding_completed_at", { withTimezone: true }),
});

export type User = typeof usersTable.$inferSelect;
export type InsertUser = typeof usersTable.$inferInsert;
