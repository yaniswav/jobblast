// Read/write access to the JobBlast configuration for the Settings API
// (routes/settings.ts).
//
// Everything here goes through this one module rather than editing the
// config ad hoc, for two reasons:
//
//   1. Surgical writes (selfhosted). A naive `JSON.parse` -> mutate ->
//      `JSON.stringify` round-trip would re-flow the *entire* file through a
//      generic pretty-printer, blowing away the hand-tuned formatting of
//      jobblast.config.json (e.g. `scoring.rules[]` entries are one object
//      per line). We use `jsonc-parser`'s `modify`/`applyEdits` instead -
//      the same library VS Code uses to edit settings.json - which computes
//      a minimal text edit for exactly the path being changed and leaves
//      every other byte of the file untouched. A write that sets a key to
//      its current value is therefore a true no-op (verified: empty diff).
//   2. One choke point for the two modes. `selfhosted` keeps the file;
//      `saas` reads and writes `user_settings.config`, validated by the same
//      JobBlastConfigSchema. Nothing about *where* the config lives leaks
//      past this module.
//
// Secrets (API keys) are never read or written here: they live in `.env`
// and stay there. See docs/CONFIG.md.

import fs from "node:fs";
import { eq } from "drizzle-orm";
import { applyEdits, modify, type JSONPath } from "jsonc-parser";
import { db, userSettingsTable } from "@workspace/db";
import {
  clearUserConfig,
  configPath,
  JobBlastConfigSchema,
  loadConfig,
  resetConfigCache,
  setUserConfig,
  type AiProviderName,
  type JobBlastConfig,
  type WatchedCompanyConfig,
} from "./config";
import { IS_SAAS } from "./mode";
import { currentUserId } from "./user-context";
import { forgetUserProvider } from "./ai/provider";

const FORMATTING_OPTIONS = { tabSize: 2, insertSpaces: true, eol: "\n" };

// ---------------------------------------------------------------------------
// saas backend: one jsonb column per account
// ---------------------------------------------------------------------------

/**
 * Loads an account's stored config into the process-wide cache that the
 * synchronous `loadConfig()` reads. Called by the auth middleware before any
 * handler runs; a missing row is not an error, it means "all defaults".
 */
export async function primeUserConfig(userId: string): Promise<void> {
  const [row] = await db
    .select({ config: userSettingsTable.config })
    .from(userSettingsTable)
    .where(eq(userSettingsTable.userId, userId))
    .limit(1);

  const result = JobBlastConfigSchema.safeParse(row?.config ?? {});
  if (!result.success) {
    throw new Error(
      `Stored settings for user ${userId} failed validation:\n${JSON.stringify(
        result.error.format(),
        null,
        2,
      )}`,
    );
  }
  setUserConfig(userId, result.data);
}

function requireCurrentUserId(): string {
  const userId = currentUserId();
  if (!userId) {
    throw new Error("Settings were written with no ambient user in saas mode.");
  }
  return userId;
}

/** Merges `patch` into the account's stored config at `path`, validates, writes. */
async function writeUserConfig(
  patches: Array<{ path: JSONPath; value: unknown }>,
): Promise<void> {
  const userId = requireCurrentUserId();
  const [row] = await db
    .select({ config: userSettingsTable.config })
    .from(userSettingsTable)
    .where(eq(userSettingsTable.userId, userId))
    .limit(1);

  // No formatting to preserve here (no human reads this JSON), but reusing
  // the same jsonc-parser edit keeps one code path for "set this key".
  let text = JSON.stringify(row?.config ?? {}, null, 2);
  for (const patch of patches) {
    text = applyEdits(
      text,
      modify(text, patch.path, patch.value, { formattingOptions: FORMATTING_OPTIONS }),
    );
  }

  const result = JobBlastConfigSchema.safeParse(JSON.parse(text));
  if (!result.success) {
    throw new Error(
      `Settings update failed validation:\n${JSON.stringify(result.error.format(), null, 2)}`,
    );
  }

  const stored = JSON.parse(text) as JobBlastConfig;
  await db
    .insert(userSettingsTable)
    .values({ userId, config: stored })
    .onConflictDoUpdate({
      target: userSettingsTable.userId,
      set: { config: stored, updatedAt: new Date() },
    });

  setUserConfig(userId, result.data);
  // This account's provider was built from the settings that just changed;
  // no other account's was.
  forgetUserProvider(userId);
}

// ---------------------------------------------------------------------------
// selfhosted backend: the file on disk
// ---------------------------------------------------------------------------

function readRawText(): string {
  try {
    return fs.readFileSync(configPath(), "utf8");
  } catch {
    // No config file yet: start from an empty object, same as loadConfig().
    return "{}\n";
  }
}

/** Applies one surgical edit at `path`, leaving the rest of the text untouched. */
function applyPatch(text: string, path: JSONPath, value: unknown): string {
  const edits = modify(text, path, value, { formattingOptions: FORMATTING_OPTIONS });
  return applyEdits(text, edits);
}

/**
 * Validates the fully-merged config text (fail fast, same as `loadConfig`)
 * and writes it atomically (temp file + rename), then invalidates both
 * caches so the very next read anywhere in the app sees the new values.
 */
function commit(text: string): void {
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(text);
  } catch (err) {
    throw new Error(`Settings update produced invalid JSON: ${(err as Error).message}`);
  }

  const result = JobBlastConfigSchema.safeParse(parsedJson);
  if (!result.success) {
    throw new Error(`Settings update failed validation:\n${JSON.stringify(result.error.format(), null, 2)}`);
  }

  const file = configPath();
  const tmpFile = `${file}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmpFile, text, "utf8");
  fs.renameSync(tmpFile, file); // atomic on the same filesystem (POSIX rename / Windows MoveFileEx)

  resetConfigCache();
  // One implicit account here, so "forget everything" is "forget its one entry".
  forgetUserProvider();
}

/** Runs the write against whichever backend this process is using. */
async function writeSettings(
  patches: Array<{ path: JSONPath; value: unknown }>,
): Promise<void> {
  if (patches.length === 0) return;
  if (IS_SAAS) {
    await writeUserConfig(patches);
    return;
  }
  let text = readRawText();
  for (const patch of patches) text = applyPatch(text, patch.path, patch.value);
  commit(text);
}

// ---------------------------------------------------------------------------
// AI provider + model
// ---------------------------------------------------------------------------

export type AiSettings = { provider: AiProviderName; model: string };
export type AiSettingsPatch = Partial<AiSettings>;

export function readAiSettings(): AiSettings {
  const { ai } = loadConfig();
  return { provider: ai.provider, model: ai.model };
}

/** Merges `patch` into `ai.provider` / `ai.model`, validates, writes, returns the new state. */
export async function writeAiSettings(patch: AiSettingsPatch): Promise<AiSettings> {
  const patches: Array<{ path: JSONPath; value: unknown }> = [];
  if (patch.provider !== undefined) patches.push({ path: ["ai", "provider"], value: patch.provider });
  if (patch.model !== undefined) patches.push({ path: ["ai", "model"], value: patch.model });
  await writeSettings(patches);
  return readAiSettings();
}

// ---------------------------------------------------------------------------
// Search criteria (G1 onboarding lot): the subset of `sources.*` / `scoring`
// / `candidate` that pilots the shared refresh and the scoring pass, exposed
// as one small, named surface instead of the whole config.
//
// `keywords` fans out to every enabled source whose query is a free-text
// keyword list (France Travail, Adzuna, Himalayas): they are three different
// config paths today, but one thing from this account's point of view - "what
// am I searching for". `targetLocationKeywords` overrides the scoring pass's
// location bonus/penalty platform-wide (docs/CONFIG.md); it deliberately does
// NOT touch source-side location narrowing (Adzuna's `where`, France
// Travail's `departements`), which stay France-scoped defaults - a fresh
// account targeting elsewhere gets correctly-scored results, just from a
// still France-leaning fetch. Worth widening in a later lot.
// ---------------------------------------------------------------------------

export type SearchCriteriaSettings = {
  keywords: string[];
  targetLocationKeywords: string[];
  letterLanguages: string[];
};
export type SearchCriteriaPatch = Partial<SearchCriteriaSettings>;

export function readSearchCriteria(): SearchCriteriaSettings {
  const cfg = loadConfig();
  return {
    keywords: cfg.sources.franceTravail.keywords,
    targetLocationKeywords: cfg.scoring.targetLocationKeywords,
    letterLanguages: cfg.candidate.letterLanguages,
  };
}

export async function writeSearchCriteria(patch: SearchCriteriaPatch): Promise<SearchCriteriaSettings> {
  const patches: Array<{ path: JSONPath; value: unknown }> = [];
  if (patch.keywords !== undefined) {
    patches.push({ path: ["sources", "franceTravail", "keywords"], value: patch.keywords });
    patches.push({ path: ["sources", "adzuna", "queries"], value: patch.keywords });
    patches.push({ path: ["sources", "himalayas", "queries"], value: patch.keywords });
  }
  if (patch.targetLocationKeywords !== undefined) {
    patches.push({ path: ["scoring", "targetLocationKeywords"], value: patch.targetLocationKeywords });
  }
  if (patch.letterLanguages !== undefined) {
    patches.push({ path: ["candidate", "letterLanguages"], value: patch.letterLanguages });
    const [first] = patch.letterLanguages;
    if (first) patches.push({ path: ["candidate", "fallbackLetterLanguage"], value: first });
  }
  await writeSettings(patches);
  return readSearchCriteria();
}

// ---------------------------------------------------------------------------
// Automation toggles (Gmail sync, AI Scout, Notion Inbox)
// ---------------------------------------------------------------------------

export type AutomationsSettings = {
  gmailSync: { enabled: boolean; dryRun: boolean };
  aiScout: { enabled: boolean };
  notionInbox: { enabled: boolean; pageUrl: string; dataSourceUrl: string };
};

export type AutomationsPatch = {
  gmailSync?: Partial<AutomationsSettings["gmailSync"]>;
  aiScout?: Partial<AutomationsSettings["aiScout"]>;
  notionInbox?: Partial<AutomationsSettings["notionInbox"]>;
};

export function readAutomations(): AutomationsSettings {
  const cfg = loadConfig();
  return {
    gmailSync: { enabled: cfg.gmailSync.enabled, dryRun: cfg.gmailSync.dryRun },
    aiScout: { enabled: cfg.sources.aiScout.enabled },
    notionInbox: {
      enabled: cfg.sources.notionInbox.enabled,
      pageUrl: cfg.sources.notionInbox.pageUrl,
      dataSourceUrl: cfg.sources.notionInbox.dataSourceUrl,
    },
  };
}

export async function writeAutomations(patch: AutomationsPatch): Promise<AutomationsSettings> {
  const patches: Array<{ path: JSONPath; value: unknown }> = [];
  if (patch.gmailSync?.enabled !== undefined)
    patches.push({ path: ["gmailSync", "enabled"], value: patch.gmailSync.enabled });
  if (patch.gmailSync?.dryRun !== undefined)
    patches.push({ path: ["gmailSync", "dryRun"], value: patch.gmailSync.dryRun });
  if (patch.aiScout?.enabled !== undefined)
    patches.push({ path: ["sources", "aiScout", "enabled"], value: patch.aiScout.enabled });
  if (patch.notionInbox?.enabled !== undefined)
    patches.push({ path: ["sources", "notionInbox", "enabled"], value: patch.notionInbox.enabled });
  if (patch.notionInbox?.pageUrl !== undefined)
    patches.push({ path: ["sources", "notionInbox", "pageUrl"], value: patch.notionInbox.pageUrl });
  if (patch.notionInbox?.dataSourceUrl !== undefined)
    patches.push({
      path: ["sources", "notionInbox", "dataSourceUrl"],
      value: patch.notionInbox.dataSourceUrl,
    });
  await writeSettings(patches);
  return readAutomations();
}

/** Drops an account's primed config, e.g. after its row changed elsewhere. */
export function forgetUserConfig(userId: string): void {
  clearUserConfig(userId);
}

// ---------------------------------------------------------------------------
// Company Watch (lot H2): companies added via POST /settings/companies.
// lib/sources/ats/detect.ts identifies `ats` + `board` from the pasted URL;
// this module only stores/removes the result. The shared refresh reads it
// back through lib/sources/companies.ts (watchedCompaniesFor / mergeCompanyBoards).
// ---------------------------------------------------------------------------

export function readWatchedCompanies(): WatchedCompanyConfig[] {
  return loadConfig().watchedCompanies;
}

/** Adding the same URL twice is a no-op, not a duplicate row. */
export async function addWatchedCompany(entry: WatchedCompanyConfig): Promise<WatchedCompanyConfig> {
  const current = loadConfig().watchedCompanies;
  const existing = current.find((c) => c.url === entry.url);
  if (existing) return existing;
  await writeSettings([{ path: ["watchedCompanies"], value: [...current, entry] }]);
  return entry;
}

/** Returns false when no watched company had this id (nothing to delete). */
export async function removeWatchedCompany(id: string): Promise<boolean> {
  const current = loadConfig().watchedCompanies;
  const next = current.filter((c) => c.id !== id);
  if (next.length === current.length) return false;
  await writeSettings([{ path: ["watchedCompanies"], value: next }]);
  return true;
}
