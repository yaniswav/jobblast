// Database access for accounts, sessions and invite codes.
//
// Deliberately NOT under lib/repo/: those functions all take the acting
// `userId` as their first argument, and these are the ones that establish
// who that user is in the first place (look an account up by email, resolve
// a cookie into a session). Keeping them apart is what lets the scoping
// guard in lib/scoping.test.ts stay a simple, unambiguous rule.

import { and, eq, lt, or, sql } from "drizzle-orm";
import {
  db,
  inviteCodesTable,
  LOCAL_USER_ID,
  sessionsTable,
  usersTable,
  type User,
} from "@workspace/db";
import { logger } from "../logger";
import { hashPassword, validatePassword, verifyPassword } from "./password";
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

  return row.userId;
}

export async function deleteSession(token: string): Promise<void> {
  await db
    .delete(sessionsTable)
    .where(eq(sessionsTable.tokenHash, hashSessionToken(token)));
}
