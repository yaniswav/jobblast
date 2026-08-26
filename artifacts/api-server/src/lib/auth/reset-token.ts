// Password reset tokens: same shape as session.ts (opaque random token,
// only its hash stored, expiry checked as a pure function of a clock you
// pass in) - see lib/db/src/schema/passwordResetTokens.ts for the row this
// backs and lib/auth/store.ts for the impure shell around it.

import crypto from "node:crypto";

/** TTL from creation - docs/SAAS-ARCHITECTURE.md section 2. */
export const RESET_TOKEN_TTL_MS = 30 * 60 * 1000;

/** A fresh 256-bit token, URL-safe so it survives both a cookie-less link and a query string unencoded. */
export function generateResetToken(): string {
  return crypto.randomBytes(32).toString("base64url");
}

/** What the database stores. Never the raw token. */
export function hashResetToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

export function resetTokenExpiry(now: number): number {
  return now + RESET_TOKEN_TTL_MS;
}

export type ResetTokenRow = { expiresAt: number; usedAt: number | null };

/**
 * True only for a token that has neither expired nor already been consumed.
 * The real check is a single atomic UPDATE ... WHERE in
 * lib/auth/store.ts's consumePasswordResetToken() (it has to be: the
 * single-use guarantee needs one round trip, not a read then a write) - this
 * exists as the spec that WHERE clause has to match, tested once here rather
 * than trusted by inspection. Same idiom as isSessionExpired() /
 * isPrunablePosting() in lib/queue/hygiene-selection.ts.
 */
export function isResetTokenUsable(row: ResetTokenRow, now: number): boolean {
  if (row.usedAt !== null) return false;
  return row.expiresAt > now;
}
