// Storage for per-account BYOK AI provider credentials
// (docs/SAAS-ARCHITECTURE.md section 5). See lib/repo/postings.ts for why
// the `userId` parameter is not optional.
//
// The decrypted key never leaves this module except through
// `decryptCredential`, which only the BYOK "test this key" route calls, and
// which never logs or returns its result to a client - every other export
// here works with a masked CredentialStatus.

import { and, eq } from "drizzle-orm";
import { aiCredentialsTable, db, type AiCredential } from "@workspace/db";
import { decryptSecret, encryptSecret, hintFor } from "../crypto/byok";
import type { ByokProviderName } from "../config";

export type CredentialStatus = {
  provider: ByokProviderName;
  configured: boolean;
  hint: string | null;
  lastOkAt: Date | null;
  lastError: string | null;
};

function toStatus(provider: ByokProviderName, row: AiCredential | null): CredentialStatus {
  if (!row) return { provider, configured: false, hint: null, lastOkAt: null, lastError: null };
  return { provider, configured: true, hint: row.hint, lastOkAt: row.lastOkAt, lastError: row.lastError };
}

export async function getCredentialRow(
  userId: string,
  provider: ByokProviderName,
): Promise<AiCredential | null> {
  const [row] = await db
    .select()
    .from(aiCredentialsTable)
    .where(and(eq(aiCredentialsTable.userId, userId), eq(aiCredentialsTable.provider, provider)))
    .limit(1);
  return row ?? null;
}

export async function getCredentialStatus(
  userId: string,
  provider: ByokProviderName,
): Promise<CredentialStatus> {
  return toStatus(provider, await getCredentialRow(userId, provider));
}

export async function listCredentialStatuses(
  userId: string,
  providers: readonly ByokProviderName[],
): Promise<CredentialStatus[]> {
  return Promise.all(providers.map((provider) => getCredentialStatus(userId, provider)));
}

/**
 * Encrypts and upserts one account's key for one provider. A fresh key
 * invalidates any previous test result, so lastOkAt/lastError reset to
 * unknown rather than carrying a stale verdict about a different secret.
 */
export async function storeCredential(
  userId: string,
  provider: ByokProviderName,
  apiKey: string,
): Promise<CredentialStatus> {
  const encrypted = encryptSecret(userId, provider, apiKey);
  const hint = hintFor(apiKey);
  const ivB64 = encrypted.iv.toString("base64");
  const ciphertextB64 = encrypted.ciphertext.toString("base64");
  const authTagB64 = encrypted.authTag.toString("base64");

  await db
    .insert(aiCredentialsTable)
    .values({
      userId,
      provider,
      keyVersion: encrypted.keyVersion,
      iv: ivB64,
      ciphertext: ciphertextB64,
      authTag: authTagB64,
      hint,
      lastOkAt: null,
      lastError: null,
    })
    .onConflictDoUpdate({
      target: [aiCredentialsTable.userId, aiCredentialsTable.provider],
      set: {
        keyVersion: encrypted.keyVersion,
        iv: ivB64,
        ciphertext: ciphertextB64,
        authTag: authTagB64,
        hint,
        lastOkAt: null,
        lastError: null,
        updatedAt: new Date(),
      },
    });

  return { provider, configured: true, hint, lastOkAt: null, lastError: null };
}

export async function deleteCredential(userId: string, provider: ByokProviderName): Promise<void> {
  await db
    .delete(aiCredentialsTable)
    .where(and(eq(aiCredentialsTable.userId, userId), eq(aiCredentialsTable.provider, provider)));
}

/**
 * Decrypts the stored key in memory, for one call, right now. Only the
 * "test this key" route may use this - never returned to a client, never
 * logged, never cached.
 */
export async function decryptCredential(
  userId: string,
  provider: ByokProviderName,
): Promise<string | null> {
  const row = await getCredentialRow(userId, provider);
  if (!row) return null;
  return decryptSecret(userId, provider, {
    keyVersion: row.keyVersion,
    iv: Buffer.from(row.iv, "base64"),
    ciphertext: Buffer.from(row.ciphertext, "base64"),
    authTag: Buffer.from(row.authTag, "base64"),
  });
}

/**
 * Records the outcome of a real test call against the stored credential.
 * Success clears any previous error; failure leaves lastOkAt untouched, so
 * "worked as of <date>, now failing" stays visible instead of being wiped.
 */
export async function recordCredentialTestResult(
  userId: string,
  provider: ByokProviderName,
  result: { ok: boolean; error: string | null },
): Promise<void> {
  await db
    .update(aiCredentialsTable)
    .set(
      result.ok
        ? { lastOkAt: new Date(), lastError: null, updatedAt: new Date() }
        : { lastError: result.error, updatedAt: new Date() },
    )
    .where(and(eq(aiCredentialsTable.userId, userId), eq(aiCredentialsTable.provider, provider)));
}
