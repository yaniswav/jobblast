// Database access for accounts, sessions and invite codes.
//
// Deliberately NOT under lib/repo/: those functions all take the acting
// `userId` as their first argument, and these are the ones that establish
// who that user is in the first place (look an account up by email, resolve
// a cookie into a session). Keeping them apart is what lets the scoping
// guard in lib/scoping.test.ts stay a simple, unambiguous rule.

import fs from "node:fs";
import { and, eq, gt, inArray, isNull, lt, or, sql } from "drizzle-orm";
import {
  db,
  inviteCodesTable,
  LOCAL_USER_ID,
  passwordResetTokensTable,
  sessionsTable,
  usersTable,
  type User,
} from "@workspace/db";
import { logger } from "../logger";
import { removeUserFromPendingJobs } from "../queue/store";
import { userDataDir } from "../storage";
import { hashPassword, validatePassword, verifyPassword } from "./password";
import { generateResetToken, hashResetToken, resetTokenExpiry } from "./reset-token";
import {
  DEFAULT_SESSION_POLICY,
  generateSessionToken,
  hashIp,
  hashSessionToken,
  nextExpiry,
  shouldTouch,
} from "./session";

/**
 * Beta size cap, in code rather than in a spreadsheet (see section 6 of
 * docs/SAAS-ARCHITECTURE.md). Counts the implicit local user, which is one
 * row out of a hundred and change.
 */
const DEFAULT_MAX_ACCOUNTS = 150;

function maxAccounts(): number {
  const raw = Number(process.env["JOBBLAST_MAX_ACCOUNTS"]);
  return Number.isInteger(raw) && raw > 0 ? raw : DEFAULT_MAX_ACCOUNTS;
}

/** Salt for the session row's IP hash. Absent means "do not store an IP at all". */
function ipSalt(): string | null {
  return process.env["JOBBLAST_IP_SALT"]?.trim() || null;
}

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

let localUserReady: Promise<void> | null = null;

/**
 * Seeds the implicit account every self-hosted install runs as. Idempotent
 * and memoized per process, so the mode-gated middleware can await it on
 * every request without paying for a query each time.
 */
export function ensureLocalUser(): Promise<void> {
  localUserReady ??= (async () => {
    await db
      .insert(usersTable)
      .values({
        id: LOCAL_USER_ID,
        email: "local@jobblast.local",
        passwordHash: "",
        displayName: "Local user",
        // Self-hosted has no onboarding wizard at all (lib/onboarding.ts) -
        // belt and suspenders alongside the IS_SAAS gate the frontend already
        // checks, so this column can never make a self-hosted install redirect
        // anywhere.
        onboardingCompletedAt: new Date(),
      })
      .onConflictDoNothing();
  })().catch((err: unknown) => {
    // Do not memoize a failure: a transient database hiccup at boot must not
    // wedge every later request.
    localUserReady = null;
    throw err;
  });
  return localUserReady;
}

/**
 * Every account the background schedule should be doing work for. Ordered by
 * id so a refresh cycle enumerates them the same way twice, which makes the
 * signature grouping in lib/sources/signature.ts reproducible.
 *
 * Not in lib/repo/ for the same reason as everything else in this file: it
 * spans accounts by definition, and the repo layer's contract is that
 * nothing there does.
 */
export async function listActiveUserIds(): Promise<string[]> {
  const rows = await db
    .select({ id: usersTable.id })
    .from(usersTable)
    .where(eq(usersTable.status, "active"))
    .orderBy(usersTable.id);
  return rows.map((row) => row.id);
}

export async function getUserById(userId: string): Promise<User | null> {
  const [row] = await db
    .select()
    .from(usersTable)
    .where(eq(usersTable.id, userId))
    .limit(1);
  return row ?? null;
}

/** Case-insensitive lookup by address. Never throws on "not found" - callers that must not confirm an address exists (forgot-password) check for null themselves. */
export async function getUserByEmail(rawEmail: string): Promise<User | null> {
  const [row] = await db
    .select()
    .from(usersTable)
    .where(eq(usersTable.email, normalizeEmail(rawEmail)))
    .limit(1);
  return row ?? null;
}

/**
 * Every account id that still exists, from a candidate list. Used by
 * lib/queue/handlers.ts's runRefresh() to tolerate a subscriber deleted
 * after a shared-refresh job was enqueued but before it ran - see that
 * file's doc comment on the FK-violation bug this guards against.
 */
export async function filterExistingUserIds(userIds: readonly string[]): Promise<string[]> {
  if (userIds.length === 0) return [];
  const rows = await db
    .select({ id: usersTable.id })
    .from(usersTable)
    .where(inArray(usersTable.id, [...userIds]));
  return rows.map((row) => row.id);
}

export type RegisterInput = {
  email: string;
  password: string;
  inviteCode: string;
  displayName?: string | undefined;
  locale?: string | undefined;
};

export type RegisterResult =
  | { ok: true; user: User }
  | { ok: false; error: string };

/**
 * Invite code, then account, then usage bump - all in one transaction, so
 * two people racing on a single-use code cannot both get in.
 */
export async function registerUser(input: RegisterInput): Promise<RegisterResult> {
  const email = normalizeEmail(input.email);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return { ok: false, error: "Enter a valid email address." };
  }

  const passwordProblem = validatePassword(input.password);
  if (passwordProblem) return { ok: false, error: passwordProblem };

  const code = input.inviteCode.trim().toUpperCase();
  if (!code) return { ok: false, error: "An invite code is required." };

  const passwordHash = await hashPassword(input.password);

  try {
    return await db.transaction(async (tx) => {
      const [{ count }] = await tx
        .select({ count: sql<number>`count(*)::int` })
        .from(usersTable);
      if ((count ?? 0) >= maxAccounts()) {
        return { ok: false as const, error: "Registration is closed: the beta is full." };
      }

      // The WHERE clause is the check: an exhausted or expired code updates
      // no row, so there is no read-then-write window to lose.
      const [invite] = await tx
        .update(inviteCodesTable)
        .set({ usedCount: sql`${inviteCodesTable.usedCount} + 1` })
        .where(
          and(
            eq(inviteCodesTable.code, code),
            lt(inviteCodesTable.usedCount, inviteCodesTable.maxUses),
            or(
              sql`${inviteCodesTable.expiresAt} is null`,
              sql`${inviteCodesTable.expiresAt} > now()`,
            ),
          ),
        )
        .returning({ code: inviteCodesTable.code });
      if (!invite) {
        return { ok: false as const, error: "That invite code is not valid." };
      }

      const [user] = await tx
        .insert(usersTable)
        .values({
          email,
          passwordHash,
          displayName: input.displayName?.trim() || null,
          locale: input.locale?.trim() || null,
        })
        .returning();
      if (!user) return { ok: false as const, error: "Could not create the account." };

      return { ok: true as const, user };
    });
  } catch (err) {
    // The only expected failure here is the unique index on email. Say the
    // same thing either way, so registration never confirms an address.
    logger.warn({ err }, "Registration failed");
    return { ok: false, error: "That invite code is not valid." };
  }
}

/**
 * Verifies credentials. Always pays for one argon2 verification, even when
 * the address is unknown, so response time does not reveal which accounts
 * exist.
 */
export async function authenticate(
  rawEmail: string,
  password: string,
): Promise<User | null> {
  const email = normalizeEmail(rawEmail);
  const [user] = await db
    .select()
    .from(usersTable)
    .where(eq(usersTable.email, email))
    .limit(1);

  // A hash that exists but can never match, so the unknown-address path does
  // the same work as the wrong-password one.
  const DUMMY_HASH =
    "$argon2id$v=19$m=19456,t=2,p=1$YWJjZGVmZ2hpamtsbW5vcA$L4nX1sVQ7pHqyF6IuMzM0Bp8j7v4gTQ0mQOgKvWq2wA";
  const ok = await verifyPassword(user?.passwordHash || DUMMY_HASH, password);
  if (!ok || !user) return null;
  if (user.status !== "active") return null;
  // The local user has an empty hash and is rejected by verifyPassword, but
  // be explicit: self-hosted has no login screen and no password to guess.
  if (user.id === LOCAL_USER_ID) return null;

  await db
    .update(usersTable)
    .set({ lastLoginAt: new Date() })
    .where(eq(usersTable.id, user.id));
  return user;
}

/** Issues a session and returns the raw token to put in the cookie. */
export async function createSession(
  userId: string,
  meta: { userAgent?: string | undefined; ip?: string | undefined },
): Promise<{ token: string; expiresAt: Date }> {
  const token = generateSessionToken();
  const now = Date.now();
  const expiresAt = new Date(nextExpiry(now, now));
  const salt = ipSalt();

  await db.insert(sessionsTable).values({
    userId,
    tokenHash: hashSessionToken(token),
    expiresAt,
    userAgent: meta.userAgent?.slice(0, 300) ?? null,
    ipHash: salt && meta.ip ? hashIp(meta.ip, salt) : null,
  });

  return { token, expiresAt };
}

/**
 * Resolves a cookie value into a user id, rolling the expiry forward at most
 * once every SessionPolicy.touchAfterMs. Returns null for an unknown,
 * expired or deleted session.
 */
export async function resolveSession(token: string): Promise<string | null> {
  const tokenHash = hashSessionToken(token);
  const [row] = await db
    .select()
    .from(sessionsTable)
    .where(eq(sessionsTable.tokenHash, tokenHash))
    .limit(1);
  if (!row) return null;

  const now = Date.now();
  if (row.expiresAt.getTime() <= now) {
    await db.delete(sessionsTable).where(eq(sessionsTable.id, row.id));
    return null;
  }

  if (shouldTouch(row.lastSeenAt.getTime(), now, DEFAULT_SESSION_POLICY)) {
    await db
      .update(sessionsTable)
      .set({
        lastSeenAt: new Date(now),
        expiresAt: new Date(nextExpiry(row.createdAt.getTime(), now)),
      })
      .where(eq(sessionsTable.id, row.id));
  }

  await touchUserLastSeen(row.userId, new Date(now));

  return row.userId;
}

export async function deleteSession(token: string): Promise<void> {
  await db
    .delete(sessionsTable)
    .where(eq(sessionsTable.tokenHash, hashSessionToken(token)));
}

/** How often users.last_seen_at is written for a busy account (item 7, v0.4 pre-beta lot). */
const LAST_SEEN_TOUCH_MS = 24 * 60 * 60 * 1000;

/**
 * Inactivity tracking: refreshes `users.last_seen_at` at most once a day per
 * account, and clears `inactivityWarningSentAt` in the same UPDATE - an
 * account that comes back after being warned gets a clean slate, so a later
 * inactive stretch can warn it again rather than silently skipping straight
 * to deletion (lib/queue/inactivity-selection.ts). A single conditional
 * UPDATE (no read first), so a normal request pays for one no-op write most
 * of the time rather than a read plus a write. Only ever called from
 * resolveSession(), so this only runs in saas - selfhosted never issues a
 * session at all.
 */
async function touchUserLastSeen(userId: string, now: Date): Promise<void> {
  const staleBefore = new Date(now.getTime() - LAST_SEEN_TOUCH_MS);
  await db
    .update(usersTable)
    .set({ lastSeenAt: now, inactivityWarningSentAt: null })
    .where(and(eq(usersTable.id, userId), or(isNull(usersTable.lastSeenAt), lt(usersTable.lastSeenAt, staleBefore))));
}

/**
 * Deletes the account row. Every child table references `users(id)` with
 * `on delete cascade` (sessions, user_settings, user_ai_credentials,
 * usage_counters, profiles, applications, documents, interview_briefs,
 * user_postings, password_reset_tokens, per-account jobs), so this one
 * statement removes the account's entire footprint in the database - except
 * one thing the FK graph cannot reach: a pending `postings.refresh` job's
 * payload names its subscribers by id inside a jsonb array, not a foreign
 * key, so this account's id can be left behind in another job's payload
 * after this row is gone (see lib/queue/store.ts's removeUserFromPendingJobs
 * doc comment, and lib/queue/handlers.ts's runRefresh for the bug that
 * caused). deleteAccountCompletely() below is the entry point that actually
 * cleans that up first; call that, not this, unless a caller specifically
 * needs the bare row delete.
 *
 * Deliberately not in lib/repo/: same reason as the rest of this file, it
 * establishes/removes who an account IS rather than acting on behalf of one
 * that already exists mid-request.
 */
export async function deleteAccount(userId: string): Promise<void> {
  await db.delete(usersTable).where(eq(usersTable.id, userId));
}

/**
 * The one real "delete this account" entry point, used by both
 * `DELETE /account` (routes/account.ts, self-service) and the inactivity
 * purge job (lib/queue/handlers.ts "users.inactivity"). Order matters:
 *
 *   1. Scrub this account's id out of any pending platform-wide job payload
 *      (the gap the FK graph cannot cover - see deleteAccount()'s comment).
 *   2. Delete the row, cascading everything else.
 *   3. Best-effort remove `data/users/<uuid>/` on disk. A failure here is
 *      logged, not thrown: the account is already gone from the database, so
 *      leaving orphaned files is a cleanup problem, not a reason to make the
 *      caller think deletion failed.
 *
 * `reason` only affects the log line ("self-service" vs "inactivity") - no
 * personal data in either case, just the account id.
 */
export async function deleteAccountCompletely(
  userId: string,
  reason: "self-service" | "inactivity",
): Promise<void> {
  await removeUserFromPendingJobs(userId);
  await deleteAccount(userId);

  try {
    await fs.promises.rm(userDataDir(userId), { recursive: true, force: true });
  } catch (err) {
    logger.error({ err, userId }, "Account deleted from the database, but its files could not be removed");
  }

  logger.info({ userId, reason }, "Account deleted");
}

// ---------------------------------------------------------------------------
// Password reset (G2 lot). Single-use, hashed at rest, 30-minute TTL - see
// lib/auth/reset-token.ts for the pure token logic this wraps in SQL.
// ---------------------------------------------------------------------------

/** Issues a reset token for an account already known to exist. Callers (routes/auth.ts) look the account up first, so a null result never reaches here. */
export async function createPasswordResetToken(
  userId: string,
): Promise<{ token: string; expiresAt: Date }> {
  const token = generateResetToken();
  const expiresAt = new Date(resetTokenExpiry(Date.now()));
  await db.insert(passwordResetTokensTable).values({
    userId,
    tokenHash: hashResetToken(token),
    expiresAt,
  });
  return { token, expiresAt };
}

/**
 * Consumes a reset token atomically: the UPDATE's own `WHERE used_at IS
 * NULL AND expires_at > now()` is the single-use guarantee, not a
 * read-then-check in application code, so two concurrent requests for the
 * same token can never both succeed. Returns the account id on success, or
 * null for an unknown, expired or already-used token - deliberately the
 * same generic outcome for all three, so a guess reveals nothing about which
 * case it was.
 */
export async function consumePasswordResetToken(token: string): Promise<{ userId: string } | null> {
  const tokenHash = hashResetToken(token);
  const now = new Date();
  const [row] = await db
    .update(passwordResetTokensTable)
    .set({ usedAt: now })
    .where(
      and(
        eq(passwordResetTokensTable.tokenHash, tokenHash),
        isNull(passwordResetTokensTable.usedAt),
        gt(passwordResetTokensTable.expiresAt, now),
      ),
    )
    .returning({ userId: passwordResetTokensTable.userId });

  return row ? { userId: row.userId } : null;
}

/**
 * Sets a new password and invalidates every session on the account - a
 * password reset is exactly the moment an attacker who had a live session
 * (the reason the account owner is resetting in the first place, sometimes)
 * must be logged out everywhere, not just have their password stop working
 * next time.
 */
export async function resetPassword(userId: string, newPassword: string): Promise<void> {
  const passwordHash = await hashPassword(newPassword);
  await db.transaction(async (tx) => {
    await tx.update(usersTable).set({ passwordHash }).where(eq(usersTable.id, userId));
    await tx.delete(sessionsTable).where(eq(sessionsTable.userId, userId));
  });
}

// ---------------------------------------------------------------------------
// Inactivity purge (G2 lot). Pure decision logic lives in
// lib/queue/inactivity-selection.ts; this is the SQL shell around it.
// ---------------------------------------------------------------------------

export type InactivityAccountRow = {
  id: string;
  email: string;
  locale: string | null;
  lastSeenAt: Date | null;
  createdAt: Date;
  inactivityWarningSentAt: Date | null;
};

/**
 * Every active account, with the fields lib/queue/inactivity-selection.ts's
 * decideInactivityAction() needs. The local user is excluded on principle
 * (selfhosted has no email and no purge concept at all), even though in
 * practice it is never seeded in saas mode to begin with.
 */
export async function listInactivityCandidates(): Promise<InactivityAccountRow[]> {
  return db
    .select({
      id: usersTable.id,
      email: usersTable.email,
      locale: usersTable.locale,
      lastSeenAt: usersTable.lastSeenAt,
      createdAt: usersTable.createdAt,
      inactivityWarningSentAt: usersTable.inactivityWarningSentAt,
    })
    .from(usersTable)
    .where(and(eq(usersTable.status, "active"), sql`${usersTable.id} <> ${LOCAL_USER_ID}`))
    .orderBy(usersTable.id);
}

export async function markInactivityWarningSent(userId: string, now: Date = new Date()): Promise<void> {
  await db.update(usersTable).set({ inactivityWarningSentAt: now }).where(eq(usersTable.id, userId));
}
