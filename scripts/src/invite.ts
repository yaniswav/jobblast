// Mints a registration invite code for SaaS mode.
//
//   pnpm run invite
//   pnpm run invite -- --uses 5 --days 30 --note "beta wave 1"
//
// Registration in `saas` mode requires one of these; there is no open signup
// form, which is what keeps the beta at the size the architecture doc plans
// for. Self-hosted mode has no registration at all and ignores this table.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const currentDir = path.dirname(fileURLToPath(import.meta.url));
// scripts/src -> scripts -> repo root
const REPO_ROOT = path.resolve(currentDir, "../..");

// Same reason as scripts/src/migrate-multi-tenant.ts: nothing loads the
// repo-root .env for a plain `tsx` process.
if (!process.env["DATABASE_URL"]) {
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

const { db, inviteCodesTable, pool } = await import("@workspace/db");

/** Crockford-ish base32: no I, L, O or U, so a code read aloud survives. */
const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

function generateCode(): string {
  const bytes = crypto.randomBytes(16);
  const letters = Array.from(bytes, (byte) => ALPHABET[byte % ALPHABET.length]);
  return `${letters.slice(0, 4).join("")}-${letters.slice(4, 8).join("")}-${letters.slice(8, 12).join("")}`;
}

function flag(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? undefined : process.argv[index + 1];
}

const uses = Number(flag("uses") ?? "1");
if (!Number.isInteger(uses) || uses < 1) {
  throw new Error(`--uses must be a positive integer, got "${flag("uses")}"`);
}

const days = flag("days") === undefined ? null : Number(flag("days"));
if (days !== null && (!Number.isFinite(days) || days <= 0)) {
  throw new Error(`--days must be a positive number, got "${flag("days")}"`);
}

const code = generateCode();

await db.insert(inviteCodesTable).values({
  code,
  note: flag("note") ?? "",
  maxUses: uses,
  expiresAt: days === null ? null : new Date(Date.now() + days * 24 * 60 * 60 * 1000),
});

console.log(code);
console.log(`  uses:    ${uses}`);
console.log(`  expires: ${days === null ? "never" : `${days} day(s)`}`);

await pool.end();
