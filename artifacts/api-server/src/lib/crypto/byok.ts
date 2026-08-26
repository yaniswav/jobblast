// AES-256-GCM encryption for per-account BYOK AI provider credentials
// (docs/SAAS-ARCHITECTURE.md section 5). Node's built-in `crypto` only - no
// new dependency, nothing native, nothing fighting the esbuild externals
// list.
//
// The master key (JOBBLAST_MASTER_KEY, 32 bytes base64) never encrypts
// anything directly: every account gets its own data key, derived with
// HKDF-SHA256 salted by the user id, so a leaked derived key cannot be used
// to derive - or even recognize - another account's key. On top of that, the
// AEAD's associated data is `${userId}:${provider}:${keyVersion}`, so a
// ciphertext copied from one user's row into another's fails authentication
// rather than decrypting. That combination is what turns "encrypted at
// rest" into real per-account isolation, not just obfuscation.
//
// Plaintext exists only inside the call that needs it (store, or the test
// endpoint): never logged, never cached, never written to disk.

import crypto from "node:crypto";

const ALGORITHM = "aes-256-gcm";
const KEY_BYTES = 32; // AES-256
const IV_BYTES = 12; // 96-bit GCM nonce, the standard size
export const CURRENT_KEY_VERSION = 1;

export type EncryptedSecret = {
  keyVersion: number;
  iv: Buffer;
  ciphertext: Buffer;
  authTag: Buffer;
};

const MASTER_KEY_ENV = "JOBBLAST_MASTER_KEY";
const BASE64_RE = /^[A-Za-z0-9+/]+=*$/;

/**
 * Pure validator: null when `raw` is a well-formed 32-byte base64 master
 * key, otherwise a human-readable, UI-safe reason. Never echoes the value.
 */
export function masterKeyFormatError(raw: string | undefined): string | null {
  const trimmed = raw?.trim() ?? "";
  if (trimmed.length === 0) return `${MASTER_KEY_ENV} is not set.`;
  if (!BASE64_RE.test(trimmed)) return `${MASTER_KEY_ENV} is not valid base64.`;
  const decoded = Buffer.from(trimmed, "base64");
  if (decoded.length !== KEY_BYTES) {
    return `${MASTER_KEY_ENV} must decode to ${KEY_BYTES} bytes (got ${decoded.length}). Generate one with: openssl rand -base64 32`;
  }
  return null;
}

let cachedMasterKey: Buffer | null = null;

/** Reads and validates JOBBLAST_MASTER_KEY once. Throws (fail closed) rather than returning a default. */
export function masterKey(): Buffer {
  if (cachedMasterKey) return cachedMasterKey;
  const raw = process.env[MASTER_KEY_ENV];
  const problem = masterKeyFormatError(raw);
  if (problem) throw new Error(problem);
  cachedMasterKey = Buffer.from(raw!.trim(), "base64");
  return cachedMasterKey;
}

/** Test/CLI hook: forget the cached master key so the next read re-checks process.env. */
export function resetMasterKeyCache(): void {
  cachedMasterKey = null;
}

/** Per-account data key. The master key itself never encrypts anything. */
function deriveUserKey(userId: string): Buffer {
  return Buffer.from(crypto.hkdfSync("sha256", masterKey(), userId, "jobblast-byok", KEY_BYTES));
}

function associatedData(userId: string, provider: string, keyVersion: number): Buffer {
  return Buffer.from(`${userId}:${provider}:${keyVersion}`, "utf8");
}

/** Encrypts `plaintext` for one account's one provider credential. */
export function encryptSecret(
  userId: string,
  provider: string,
  plaintext: string,
  keyVersion: number = CURRENT_KEY_VERSION,
): EncryptedSecret {
  const key = deriveUserKey(userId);
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  cipher.setAAD(associatedData(userId, provider, keyVersion));
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return { keyVersion, iv, ciphertext, authTag: cipher.getAuthTag() };
}

/** Decrypts a row's stored secret. Throws on a wrong key, wrong user/provider, or tampered ciphertext. */
export function decryptSecret(userId: string, provider: string, secret: EncryptedSecret): string {
  const key = deriveUserKey(userId);
  const decipher = crypto.createDecipheriv(ALGORITHM, key, secret.iv);
  decipher.setAuthTag(secret.authTag);
  decipher.setAAD(associatedData(userId, provider, secret.keyVersion));
  const plaintext = Buffer.concat([decipher.update(secret.ciphertext), decipher.final()]);
  return plaintext.toString("utf8");
}

/** Last 4 characters of the plaintext key, the only part ever shown in the UI. */
export function hintFor(secret: string): string {
  return secret.slice(-4);
}
