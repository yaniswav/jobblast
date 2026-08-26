// Opaque server-side sessions.
//
// The cookie carries 256 bits of randomness and nothing else; the database
// stores only sha256 of it, so a leaked dump does not hand over live
// sessions. The row is the source of truth, which makes logout, "sign out
// everywhere" and account deletion a DELETE rather than a revocation-list
// problem.
//
// The expiry policy is extracted as a pure function so the rolling / idle /
// absolute interaction is testable without a clock or a database.

import crypto from "node:crypto";

export const SESSION_COOKIE_NAME = "jb_session";

export type SessionPolicy = {
  /** Hard ceiling from creation, however active the session is. */
  absoluteMs: number;
  /** How long a session survives with no request at all. */
  idleMs: number;
  /** Below this, `lastSeenAt` is not rewritten - a busy tab must not write on every request. */
  touchAfterMs: number;
};

export const DEFAULT_SESSION_POLICY: SessionPolicy = {
  absoluteMs: 30 * 24 * 60 * 60 * 1000,
  idleMs: 14 * 24 * 60 * 60 * 1000,
  touchAfterMs: 10 * 60 * 1000,
};

/** A fresh 256-bit token, URL-safe so it survives a cookie unencoded. */
export function generateSessionToken(): string {
  return crypto.randomBytes(32).toString("base64url");
}

/** What the database stores. Never store the token itself. */
export function hashSessionToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

/** IP addresses on a session row are only ever kept as a salted hash. */
export function hashIp(ip: string, salt: string): string {
  return crypto.createHash("sha256").update(`${ip}${salt}`).digest("hex");
}

/**
 * Rolling expiry: `min(createdAt + absolute, now + idle)`. A session that
 * has been alive for 29 days gets one more day however busy it is; an idle
 * one dies 14 days after its last request.
 */
export function nextExpiry(
  createdAt: number,
  now: number,
  policy: SessionPolicy = DEFAULT_SESSION_POLICY,
): number {
  return Math.min(createdAt + policy.absoluteMs, now + policy.idleMs);
}

/** Whether this request should pay for a `last_seen_at` write. */
export function shouldTouch(
  lastSeenAt: number,
  now: number,
  policy: SessionPolicy = DEFAULT_SESSION_POLICY,
): boolean {
  return now - lastSeenAt >= policy.touchAfterMs;
}

/** Whether a stored session is still usable at `now`. */
export function isExpired(expiresAt: number, now: number): boolean {
  return expiresAt <= now;
}
