// Read/write access to jobblast.config.json for the Settings API
// (routes/settings.ts).
//
// Everything here goes through this one module rather than editing the
// config file ad hoc, for two reasons:
//
//   1. Surgical writes. A naive `JSON.parse` -> mutate -> `JSON.stringify`
//      round-trip would re-flow the *entire* file through a generic
//      pretty-printer, blowing away the hand-tuned formatting of
//      jobblast.config.json (e.g. `scoring.rules[]` entries are one object
//      per line). We use `jsonc-parser`'s `modify`/`applyEdits` instead -
//      the same library VS Code uses to edit settings.json - which computes
//      a minimal text edit for exactly the path being changed and leaves
//      every other byte of the file untouched. A write that sets a key to
//      its current value is therefore a true no-op (verified: empty diff).
//   2. One choke point for a future SaaS. If config storage ever moves from
//      "one JSON file on disk" to "one row per user in a database", every
//      caller in routes/settings.ts only needs this module's functions to
//      keep working - nothing about *where* the config lives leaks past it.
//
// Secrets (API keys) are never read or written here: they live in `.env`
// and stay there. See docs/CONFIG.md.

import fs from "node:fs";
import { applyEdits, modify, type JSONPath } from "jsonc-parser";
import { configPath, JobBlastConfigSchema, loadConfig, resetConfigCache, type AiProviderName } from "./config";
import { resetProviderCache } from "./ai/provider";

const FORMATTING_OPTIONS = { tabSize: 2, insertSpaces: true, eol: "\n" };

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
  resetProviderCache();
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
export function writeAiSettings(patch: AiSettingsPatch): AiSettings {
  let text = readRawText();
  if (patch.provider !== undefined) text = applyPatch(text, ["ai", "provider"], patch.provider);
  if (patch.model !== undefined) text = applyPatch(text, ["ai", "model"], patch.model);
  commit(text);
  return readAiSettings();
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

export function writeAutomations(patch: AutomationsPatch): AutomationsSettings {
  let text = readRawText();
  if (patch.gmailSync?.enabled !== undefined) text = applyPatch(text, ["gmailSync", "enabled"], patch.gmailSync.enabled);
  if (patch.gmailSync?.dryRun !== undefined) text = applyPatch(text, ["gmailSync", "dryRun"], patch.gmailSync.dryRun);
  if (patch.aiScout?.enabled !== undefined) text = applyPatch(text, ["sources", "aiScout", "enabled"], patch.aiScout.enabled);
  if (patch.notionInbox?.enabled !== undefined)
    text = applyPatch(text, ["sources", "notionInbox", "enabled"], patch.notionInbox.enabled);
  if (patch.notionInbox?.pageUrl !== undefined)
    text = applyPatch(text, ["sources", "notionInbox", "pageUrl"], patch.notionInbox.pageUrl);
  if (patch.notionInbox?.dataSourceUrl !== undefined)
    text = applyPatch(text, ["sources", "notionInbox", "dataSourceUrl"], patch.notionInbox.dataSourceUrl);
  commit(text);
  return readAutomations();
}
