// Password hashing for SaaS accounts.
//
// argon2id at the OWASP baseline (19456 KiB memory, 2 iterations, 1 lane)
// via @node-rs/argon2, which ships prebuilt binaries rather than compiling
// on install. It is externalized in build.mjs for the same reason pdfkit is:
// esbuild cannot inline a native addon that resolves its own .node file at
// runtime.

import { hash, verify, type Algorithm, type Options } from "@node-rs/argon2";

// Algorithm.Argon2id. Written as a cast because the binding declares it as
// an ambient `const enum`, which `isolatedModules` refuses to read.
const ARGON2ID = 2 as Algorithm;

/** OWASP's argon2id baseline. Changing these does not invalidate old hashes: the parameters travel in the encoded string. */
export const ARGON2_OPTIONS: Options = {
  algorithm: ARGON2ID,
  memoryCost: 19456,
  timeCost: 2,
  parallelism: 1,
};

/** Long enough to matter, with no composition rules nobody can remember. */
export const MIN_PASSWORD_LENGTH = 12;
const MAX_PASSWORD_LENGTH = 256;

/**
 * A short embedded list of passwords that clear the length rule and are
 * still the first thing anyone tries. Not a substitute for a real corpus,
 * but it costs nothing and catches the obvious.
 */
const COMMON_PASSWORDS = new Set([
  "123456789012",
  "1234567890123",
  "12345678901234",
  "123456789012345",
  "passwordpassword",
  "password12345",
  "password1234",
  "qwertyuiop1234",
  "administrator",
  "letmeinletmein",
  "iloveyouiloveyou",
  "welcome123456",
  "abcdefghijkl",
  "aaaaaaaaaaaa",
  "trustno1trustno1",
  "monkeymonkey",
  "dragondragon",
  "footballfootball",
  "baseballbaseball",
  "sunshinesunshine",
]);

/** Null when acceptable, else a message safe to show the user. */
export function validatePassword(password: string): string | null {
  if (password.length < MIN_PASSWORD_LENGTH) {
    return `Password must be at least ${MIN_PASSWORD_LENGTH} characters.`;
  }
  if (password.length > MAX_PASSWORD_LENGTH) {
    return `Password must be at most ${MAX_PASSWORD_LENGTH} characters.`;
  }
  if (COMMON_PASSWORDS.has(password.toLowerCase())) {
    return "That password is too common. Pick something else.";
  }
  return null;
}

export async function hashPassword(password: string): Promise<string> {
  return hash(password, ARGON2_OPTIONS);
}

/**
 * Constant-ish time by construction: argon2 verification dominates. Returns
 * false rather than throwing on a malformed or empty stored hash, so the
 * local self-hosted user (whose hash is the empty string) can never be
 * logged into.
 */
export async function verifyPassword(
  storedHash: string,
  password: string,
): Promise<boolean> {
  if (!storedHash) return false;
  try {
    return await verify(storedHash, password);
  } catch {
    return false;
  }
}
