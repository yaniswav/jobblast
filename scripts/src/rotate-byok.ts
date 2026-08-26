// Re-encrypts every user_ai_credentials row from JOBBLAST_MASTER_KEY_PREVIOUS
// to JOBBLAST_MASTER_KEY, bumping key_version (docs/SAAS-ARCHITECTURE.md
// section 5, "Rotation"). Run this after rotating the master key - a
// suspected leak, or on a yearly schedule.
//
//   pnpm run rotate-byok             dry run: reports what would change, writes nothing
//   pnpm run rotate-byok -- --apply  applies
//
// Idempotent: for each row, it first tries decrypting with the CURRENT
// master key (JOBBLAST_MASTER_KEY) - success means this row was already
// rotated (by a previous run, or it was never touched by the old key at
// all), and it is skipped. Only a row that fails under the current key but
// succeeds under the previous one is re-encrypted. Running this twice in a
// row, or on a table that is only partially rotated, is therefore safe.
//
// The AES-256-GCM parameters below mirror
// artifacts/api-server/src/lib/crypto/byok.ts exactly (algorithm, HKDF info
// string, IV size, AAD shape - see byok.test.ts's "key rotation round trip"
// tests for the same math exercised against the real production code). Kept
// as a small independent copy rather than an import: scripts/ only depends
// on @workspace/db today, and api-server is an application, not a library
// package, so importing across that boundary would mean either adding a new
// cross-package dependency or reaching into api-server's src/ by relative
// path. If byok.ts's algorithm ever changes, this file has to change with
// it - same tradeoff scripts/src/migrate-multi-tenant.ts already makes for
// its own copy of the title/company dedup key SQL.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const currentDir = path.dirname(fileURLToPath(import.meta.url));
// scripts/src -> scripts -> repo root
const REPO_ROOT = path.resolve(currentDir, "../..");

// Nothing loads the repo-root .env for a plain `tsx` process (mirrors
// lib/db/drizzle.config.ts and the other scripts here).
if (!process.env["DATABASE_URL"] || !process.env["JOBBLAST_MASTER_KEY"]) {
  const envFile = path.join(REPO_ROOT, ".env");
  if (fs.existsSync(envFile)) {
    for (const line of fs.readFileSync(envFile, "utf8").split(/\r?\n/)) {
      const match = /^\s*([\w.-]+)\s*=\s*(.*?)\s*$/.exec(line);
      if (match?.[1] && !process.env[match[1]]) {
        process.env[match[1]] = match[2]!.replace(/^["']|["']$/g, "");
      }
    }
  }
}

const ALGORITHM = "aes-256-gcm";
const KEY_BYTES = 32;
const IV_BYTES = 12;

function parseMasterKey(name: string): Buffer {
  const raw = process.env[name]?.trim();
  if (!raw) throw new Error(`${name} is not set.`);
  const decoded = Buffer.from(raw, "base64");
  if (decoded.length !== KEY_BYTES) {
    throw new Error(`${name} must decode to ${KEY_BYTES} bytes (got ${decoded.length}).`);
  }
  return decoded;
}

function deriveUserKey(masterKeyBuf: Buffer, userId: string): Buffer {
  return Buffer.from(crypto.hkdfSync("sha256", masterKeyBuf, userId, "jobblast-byok", KEY_BYTES));
}

function associatedData(userId: string, provider: string, keyVersion: number): Buffer {
  return Buffer.from(`${userId}:${provider}:${keyVersion}`, "utf8");
}

function decrypt(
  masterKeyBuf: Buffer,
  userId: string,
  provider: string,
  keyVersion: number,
  iv: Buffer,
  ciphertext: Buffer,
  authTag: Buffer,
): string {
  const key = deriveUserKey(masterKeyBuf, userId);
  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);
  decipher.setAAD(associatedData(userId, provider, keyVersion));
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
}

function encrypt(
  masterKeyBuf: Buffer,
  userId: string,
  provider: string,
  keyVersion: number,
  plaintext: string,
): { iv: Buffer; ciphertext: Buffer; authTag: Buffer } {
  const key = deriveUserKey(masterKeyBuf, userId);
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  cipher.setAAD(associatedData(userId, provider, keyVersion));
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return { iv, ciphertext, authTag: cipher.getAuthTag() };
}

const apply = process.argv.includes("--apply");

const newKey = parseMasterKey("JOBBLAST_MASTER_KEY");
const oldKey = parseMasterKey("JOBBLAST_MASTER_KEY_PREVIOUS");

const { pool } = await import("@workspace/db");

type Row = {
  user_id: string;
  provider: string;
  key_version: number;
  iv: string;
  ciphertext: string;
  auth_tag: string;
};

async function main(): Promise<void> {
  const { rows } = await pool.query<Row>(
    "select user_id, provider, key_version, iv, ciphertext, auth_tag from user_ai_credentials order by user_id, provider",
  );

  console.log(`${rows.length} BYOK credential row(s) found.${apply ? "" : " (dry run - nothing will be written)"}\n`);

  let rotated = 0;
  let alreadyCurrent = 0;
  let failed = 0;

  for (const row of rows) {
    const label = `${row.user_id} / ${row.provider}`;
    const iv = Buffer.from(row.iv, "base64");
    const ciphertext = Buffer.from(row.ciphertext, "base64");
    const authTag = Buffer.from(row.auth_tag, "base64");

    // Already decryptable under the current key: nothing to do. This is
    // what makes re-running the script safe.
    try {
      decrypt(newKey, row.user_id, row.provider, row.key_version, iv, ciphertext, authTag);
      alreadyCurrent++;
      continue;
    } catch {
      // Falls through to the rotation attempt below.
    }

    try {
      const plaintext = decrypt(oldKey, row.user_id, row.provider, row.key_version, iv, ciphertext, authTag);
      const newVersion = row.key_version + 1;
      const encrypted = encrypt(newKey, row.user_id, row.provider, newVersion, plaintext);

      console.log(`  ${label}: v${row.key_version} -> v${newVersion}${apply ? "" : " (dry run)"}`);

      if (apply) {
        await pool.query(
          "update user_ai_credentials set key_version = $1, iv = $2, ciphertext = $3, auth_tag = $4, updated_at = now() where user_id = $5 and provider = $6",
          [
            newVersion,
            encrypted.iv.toString("base64"),
            encrypted.ciphertext.toString("base64"),
            encrypted.authTag.toString("base64"),
            row.user_id,
            row.provider,
          ],
        );
      }
      rotated++;
    } catch (err) {
      failed++;
      console.error(`  FAILED ${label}: could not decrypt with either master key (${(err as Error).message})`);
    }
  }

  console.log(
    `\n${apply ? "Rotated" : "Would rotate"}: ${rotated}. Already current: ${alreadyCurrent}. Failed: ${failed}.`,
  );
  if (!apply && rotated > 0) {
    console.log("Dry run: nothing was written. Re-run with --apply to rotate for real.");
  }

  await pool.end();
  if (failed > 0) process.exitCode = 1;
}

await main();
