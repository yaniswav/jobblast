// One-time, idempotent backfill for the `resumes` table (lot I3: multiple
// master resumes per account). Run it AFTER `pnpm run db:push` has created
// the table (an additive-only migration - see lib/db/src/schema/resumes.ts)
// and AFTER taking a database backup, per this lot's own rollout notes.
//
//   pnpm --filter @workspace/scripts run backfill-resumes -- --dry-run   report only
//   pnpm --filter @workspace/scripts run backfill-resumes                apply
//
// What it does: for every `profiles` row with real resume content (not the
// neutral placeholder every fresh account starts with), inserts one resume
// row labeled "Main" (i18n-neutral, matches lib/repo/resumes.ts's
// DEFAULT_RESUME_LABEL), content copied character-for-character from
// `profiles.master_resume`, marked as the account's default. Safe to run
// more than once: an account that already has ANY row in `resumes` is
// skipped entirely, so a second run inserts nothing.
//
// The placeholder-text check is intentionally duplicated (not imported) from
// lib/repo/profile.ts's hasRealResume/seedProfile: this package only depends
// on @workspace/db, and the string is small and stable, so a cross-package
// dependency on the api-server app for one literal is not worth adding.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const currentDir = path.dirname(fileURLToPath(import.meta.url));
// scripts/src -> scripts -> repo root
const REPO_ROOT = path.resolve(currentDir, "../..");

// Same reason as scripts/src/backfill-application-events.ts and friends:
// nothing loads the repo-root .env for a plain `tsx` process.
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

// ---------------------------------------------------------------------------
// Pure core - no I/O, no clock. Covered by backfill-resumes.test.ts.
// ---------------------------------------------------------------------------

/** The exact placeholder ensureProfile() seeds a brand-new account with (lib/repo/profile.ts's seedProfile.masterResume). */
export const PLACEHOLDER_MASTER_RESUME =
  "Paste your master resume here (or upload your CV PDF in Documents - the text is extracted into this field automatically).";

export const DEFAULT_RESUME_LABEL = "Main";

export type BackfillProfileRow = { userId: string; masterResume: string };

export type BackfillResumeInsert = { userId: string; label: string; content: string };

/** Whether `masterResume` is real, deliberate content rather than the untouched seed placeholder. */
export function isRealMasterResume(masterResume: string): boolean {
  const value = masterResume.trim();
  return value.length > 0 && value !== PLACEHOLDER_MASTER_RESUME.trim();
}

/**
 * What this script backfills: one "Main", default resume per profile with
 * real content, for every account that does not already have at least one
 * row in `resumes` - which is what makes re-running this script a no-op the
 * second time. Pure and deterministic: same input, same output.
 */
export function computeResumeBackfillInserts(
  profiles: readonly BackfillProfileRow[],
  usersWithResumes: ReadonlySet<string>,
): BackfillResumeInsert[] {
  const inserts: BackfillResumeInsert[] = [];

  for (const profile of profiles) {
    if (usersWithResumes.has(profile.userId)) continue;
    if (!isRealMasterResume(profile.masterResume)) continue;

    inserts.push({ userId: profile.userId, label: DEFAULT_RESUME_LABEL, content: profile.masterResume });
  }

  return inserts;
}

// ---------------------------------------------------------------------------
// I/O
// ---------------------------------------------------------------------------

type ProfileQueryRow = { user_id: string; master_resume: string };

async function main(): Promise<void> {
  const dryRun = process.argv.includes("--dry-run");
  const { pool } = await import("@workspace/db");

  try {
    const { rows: profileRows } = await pool.query<ProfileQueryRow>(
      "select user_id, master_resume from profiles order by id",
    );
    const profiles: BackfillProfileRow[] = profileRows.map((row) => ({
      userId: row.user_id,
      masterResume: row.master_resume,
    }));

    const { rows: resumeRows } = await pool.query<{ user_id: string }>(
      "select distinct user_id from resumes",
    );
    const usersWithResumes = new Set(resumeRows.map((row) => row.user_id));

    const inserts = computeResumeBackfillInserts(profiles, usersWithResumes);

    console.log(
      `${profiles.length} profile(s) scanned - ${inserts.length} "Main" resume(s) to insert` +
        (dryRun ? " (dry run: nothing written)" : ""),
    );

    if (inserts.length === 0) {
      console.log("Nothing to do.");
      return;
    }
    if (dryRun) return;

    const client = await pool.connect();
    try {
      await client.query("begin");
      for (const insert of inserts) {
        await client.query(
          "insert into resumes (user_id, label, content, is_default) values ($1, $2, $3, true)",
          [insert.userId, insert.label, insert.content],
        );
      }
      await client.query("commit");
      console.log(`Inserted ${inserts.length} backfilled resume(s).`);
    } catch (err) {
      await client.query("rollback").catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  } finally {
    await pool.end();
  }
}

// Only auto-run when this file is the process entry point (`tsx
// ./src/backfill-resumes.ts`), not when the test file imports its pure
// functions.
const isMainModule = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMainModule) {
  await main();
}
