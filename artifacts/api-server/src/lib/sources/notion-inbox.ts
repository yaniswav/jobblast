// "Notion Inbox" job source: a cloud-scheduled Claude routine (running on
// the user's claude.ai, independent of this app) drops job postings it finds
// into a Notion database throughout the day. This fetcher bridges that inbox
// into the local aggregation pipeline by running the headless `claude` CLI
// (which has the user's claude.ai Notion connector authorized) twice per
// cycle:
//
//   1. READ PASS - ask the CLI agent to query the inbox database for rows
//      where the "imported" checkbox is unchecked, and return them as strict
//      JSON.
//   2. MARK PASS - after validating the URLs, ask the CLI agent to check the
//      "imported" checkbox on every row it just read, so the same posting
//      isn't re-read next cycle.
//
// Which database, and what its properties are called, comes entirely from
// `sources.notionInbox` in jobblast.config.json - see docs/CONFIG.md.
//
// Design choice, spelled out because it's a little unusual: we mark a row as
// imported right after the read+URL-validation step, in this module,
// *before* refresh.ts's scoring/threshold/dedup pass ever sees it - not
// after refresh.ts finishes. That means a row whose URL died between being
// added to Notion and this fetch (dropped here) or that later scores below
// MIN_RELEVANCE_SCORE or loses the dedup pass (dropped in refresh.ts) still
// gets checked off. This is intentional: "Importé" means "the bridge has
// seen and processed this row", not "this row became a visible job_listing".
// Without it, a low-scoring or dead-link row would be re-read and
// re-attempted forever. If a row's checkbox somehow doesn't get checked
// (mark pass fails - see markRowsImported below), the worst case is it gets
// read again next cycle; refresh.ts's URL-based dedup against job_listings
// means that's harmless for rows that made it in, and for rows that didn't
// (dead URL / low score) it's just a wasted validation check, not a
// duplicate.
//
// Throttled to at most once per 3h via a timestamp file (see
// shouldSkipDueToFrequency below), same mechanism as aiscout.ts's 24h
// throttle - the refresh cycle runs every 6h so this always fires on
// schedule, but a manually-triggered refresh (POST /api/jobs/refresh)
// spammed by the user doesn't re-run the CLI on every click.

import fs from "node:fs";
import path from "node:path";
import { runClaudePrompt } from "../ai/claude-cli";
import { loadConfig } from "../config";
import { logger } from "../logger";
import { REPO_ROOT } from "../storage";
import { isHttpUrl, isNonEmptyString, parseJsonArrayResponse } from "./cli-json";
import { politeFetch } from "./http";
import type { RawJob } from "./types";

const STATE_FILE = path.join(REPO_ROOT, "data", "notion-inbox-last-run.txt");
const MIN_INTERVAL_MS = 3 * 60 * 60 * 1000; // 3h - refresh cycle is every 6h, so this always runs on schedule
const CLI_TIMEOUT_MS = 4 * 60 * 1000; // 4 minutes - a Notion query/update, not a web-search-backed scout run
const URL_CHECK_TIMEOUT_MS = 10_000;

// The claude.ai "Notion" MCP connector (account-level, authorized via
// claude.ai connector settings - not project config; check yours with
// `claude mcp list`). Server names are normalized by replacing spaces/dots
// with underscores and prefixing "mcp__"; we allow the whole server (no
// third `__tool` segment, same pattern as aiscout.ts) so notion-search,
// notion-query-data-sources, notion-fetch, notion-update-page etc. are all
// usable without hardcoding each tool name.
const ALLOWED_TOOLS = "mcp__claude_ai_Notion";

/** The strict JSON shape we ask the agent to return per inbox row. */
export type InboxRow = {
  /** The Notion page URL (or ID) of this row - needed to mark it imported later. */
  pageUrl: string;
  title: string;
  company: string;
  url: string;
  location: string;
  why: string;
  source: string;
};

/** Exported for testability (see the synthetic mapping test alongside this fetcher). */
export function isValidInboxRow(value: unknown): value is InboxRow {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    isNonEmptyString(candidate["pageUrl"]) &&
    isNonEmptyString(candidate["title"]) &&
    isNonEmptyString(candidate["company"]) &&
    isNonEmptyString(candidate["url"]) &&
    isHttpUrl(candidate["url"]) &&
    typeof candidate["location"] === "string" &&
    typeof candidate["why"] === "string" &&
    typeof candidate["source"] === "string"
  );
}

/**
 * True if the last Notion Inbox attempt (successful or not - see markRan)
 * was less than MIN_INTERVAL_MS ago. Same rationale as aiscout.ts's
 * shouldSkipDueToFrequency: reads a timestamp file rather than querying
 * job_listings, because a run that finds zero unimported rows would
 * otherwise never throttle.
 */
function shouldSkipDueToFrequency(): boolean {
  let raw: string;
  try {
    raw = fs.readFileSync(STATE_FILE, "utf8");
  } catch {
    return false; // no state file yet -> never run before -> don't skip
  }

  const lastRunMs = Date.parse(raw.trim());
  if (Number.isNaN(lastRunMs)) return false;

  return Date.now() - lastRunMs < MIN_INTERVAL_MS;
}

/** Records "the bridge attempted a run just now", regardless of outcome. */
function markRan(): void {
  try {
    fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
    fs.writeFileSync(STATE_FILE, new Date().toISOString(), "utf8");
  } catch (err) {
    logger.warn({ err }, "Notion Inbox: failed to write last-run timestamp file");
  }
}

function buildReadPrompt(): string {
  const { pageUrl, dataSourceUrl, properties: props } = loadConfig().sources.notionInbox;
  return `You have access to the user's Notion workspace via MCP tools (names starting with "mcp__claude_ai_Notion", e.g. notion-query-data-sources, notion-fetch, notion-search). Actually call them - don't just describe what you would do.

There is a Notion database used as a job-posting inbox:
- Page URL: ${pageUrl}
- Data source: ${dataSourceUrl}

Its properties are:
- "${props.title}" (title): job title
- "${props.company}" (text): company name
- "${props.url}" (url): link to the job posting
- "${props.location}" (text): location
- "${props.why}" (text): why this job matches the candidate
- "${props.source}" (text): where the posting came from
- "${props.imported}" (checkbox): whether this row has already been imported into JobBlast

Query the data source (notion-query-data-sources on ${dataSourceUrl}, or notion-fetch on ${pageUrl}) for every row where "${props.imported}" is UNCHECKED (false). Ignore rows where it is checked.

For each unchecked row, note its own Notion page URL (needed to mark it imported later - never invent this, it must be the real page URL or ID returned by the tool) and read its property values.

Return STRICT JSON: an array of objects, each shaped exactly like this:
{"pageUrl": "...", "title": "...", "company": "...", "url": "...", "location": "...", "why": "...", "source": "..."}

Rules, all mandatory:
- Map "${props.title}"->title, "${props.company}"->company, "${props.url}"->url, "${props.location}"->location, "${props.why}"->why, "${props.source}"->source.
- If a text property is empty, use "" for that field - do not omit fields.
- If there are no rows with "${props.imported}" unchecked, return an empty array [].
- This is a READ-ONLY pass - do not modify any page or check any checkbox.

Output ONLY the raw JSON array, no markdown code fences, no commentary before or after it.`;
}

function buildMarkPrompt(pageUrls: string[]): string {
  const importedProperty = loadConfig().sources.notionInbox.properties.imported;
  return `You have access to the user's Notion workspace via MCP tools (names starting with "mcp__claude_ai_Notion"), including notion-update-page. Actually call them - don't just describe what you would do.

Check (set to true/checked) the "${importedProperty}" checkbox property on each of these Notion pages, and leave every other property on each page untouched:
${pageUrls.map((u) => `- ${u}`).join("\n")}

For each page: call notion-update-page with that page's id/url, setting only the "${importedProperty}" checkbox property to checked/true. If a page can't be resolved or an update fails, skip it and continue with the rest - don't stop over one failure.

When done, reply with exactly one line: "Marked N of ${pageUrls.length} pages." where N is how many you successfully checked. No other output.`;
}

/**
 * Asks the CLI agent to check the "Importé" checkbox on every page in
 * `pageUrls`. Never throws: a failure here just means those rows get
 * re-read next cycle (see the module-level comment for why that's safe).
 */
async function markRowsImported(pageUrls: string[]): Promise<void> {
  if (pageUrls.length === 0) return;

  try {
    const result = await runClaudePrompt(buildMarkPrompt(pageUrls), {
      timeoutMs: CLI_TIMEOUT_MS,
      extraArgs: ["--allowedTools", ALLOWED_TOOLS],
    });
    logger.info(
      { pageCount: pageUrls.length, result: result.slice(0, 300) },
      "Notion Inbox: mark-imported pass completed",
    );
  } catch (err) {
    logger.warn(
      { err, pageCount: pageUrls.length },
      "Notion Inbox: mark-imported pass failed - these rows will be re-read next cycle, " +
        "but refresh.ts's URL dedup against job_listings prevents them from being inserted twice",
    );
  }
}

/** Exported for testability (see the synthetic mapping test alongside this fetcher). */
export function toRawJob(row: InboxRow): RawJob {
  const descriptionParts = [row.why.trim(), row.location.trim() ? `Location: ${row.location.trim()}` : ""].filter(
    (part) => part.length > 0,
  );
  return {
    source: "Notion Inbox",
    title: row.title,
    company: row.company,
    location: row.location || "Location not specified",
    url: row.url,
    description: descriptionParts.join(" ") || `${row.company} is hiring for ${row.title}.`,
    postedDate: new Date().toISOString().slice(0, 10),
    salaryRange: null,
  };
}

/**
 * Reads unimported rows from the "JobBlast Inbox" Notion database via the
 * headless CLI. Exported separately from fetchNotionInboxJobs so it can be
 * exercised on its own (read-only, no mark pass) for live verification.
 * Never throws - returns [] on any failure, logging why.
 */
export async function readInboxRows(): Promise<InboxRow[]> {
  let rawResult: string;
  const startedAt = Date.now();
  try {
    rawResult = await runClaudePrompt(buildReadPrompt(), {
      timeoutMs: CLI_TIMEOUT_MS,
      extraArgs: ["--allowedTools", ALLOWED_TOOLS],
    });
  } catch (err) {
    logger.error({ err, ms: Date.now() - startedAt }, "Notion Inbox: read-pass Claude CLI call failed");
    return [];
  }
  logger.info({ ms: Date.now() - startedAt }, "Notion Inbox: read-pass Claude CLI call completed");

  const parsed = parseJsonArrayResponse(rawResult);
  if (!parsed) {
    logger.warn(
      { rawResultPreview: rawResult.slice(0, 500) },
      "Notion Inbox: model output was not (or did not contain) a valid JSON array",
    );
    return [];
  }

  const rows = parsed.filter(isValidInboxRow);
  const invalidCount = parsed.length - rows.length;
  if (invalidCount > 0) {
    logger.warn({ invalidCount, total: parsed.length }, "Notion Inbox: dropped malformed rows");
  }
  return rows;
}

/**
 * Full bridge cycle: reads unimported rows from the Notion inbox, verifies
 * their posting URLs are live, marks every row read as imported (see the
 * module-level comment for why that happens regardless of URL validity or
 * later scoring), and maps survivors to RawJob[] with source "Notion Inbox".
 *
 * Throttled to at most once per 3h. Never throws - any failure results in
 * an empty array, same as every other source fetcher in the allSettled
 * pipeline in refresh.ts.
 */
export async function fetchNotionInboxJobs(): Promise<RawJob[]> {
  const { pageUrl, dataSourceUrl } = loadConfig().sources.notionInbox;
  if (!pageUrl.trim() || !dataSourceUrl.trim()) {
    logger.warn(
      "Notion Inbox: sources.notionInbox.pageUrl / dataSourceUrl are not configured, skipping",
    );
    return [];
  }

  if (shouldSkipDueToFrequency()) {
    logger.info("Notion Inbox: skipped, last run was under 3h ago");
    return [];
  }

  // Mark the attempt now (before the slow CLI calls), same rationale as
  // aiscout.ts: avoids back-to-back runs if this crashes mid-flight or a
  // second refresh cycle fires while this one is still in progress.
  markRan();

  const rows = await readInboxRows();
  if (rows.length === 0) {
    logger.info("Notion Inbox: no unimported rows found");
    return [];
  }

  // URL validation pass: a row's posting link can be dead/stale by the time
  // we get to it. Verify each one actually resolves before handing it to
  // the aggregation pipeline - but still mark every row (dead or alive) as
  // imported below, so a dead link doesn't get re-checked forever.
  const verified: InboxRow[] = [];
  for (const row of rows) {
    try {
      const res = await politeFetch(row.url, { method: "GET" }, URL_CHECK_TIMEOUT_MS);
      // Only clearly-dead URLs are dropped (404/410). Anti-bot responses
      // (403, 405, 429, Cloudflare 503, LinkedIn-style 999...) mean the page
      // exists but refuses automated clients - the human applying will open
      // it in a real browser, so keep the row. Verified live: Indeed's
      // to.indeed.com short links 403 curl-like clients while working fine
      // in a browser.
      if (res.status === 404 || res.status === 410) {
        logger.debug({ url: row.url, status: res.status }, "Notion Inbox: dropping dead URL");
      } else {
        verified.push(row);
      }
    } catch (err) {
      // Network-level failure (NXDOMAIN, timeout, TLS): genuinely unreachable.
      logger.debug({ url: row.url, err }, "Notion Inbox: URL check errored, dropping");
    }
  }
  const droppedCount = rows.length - verified.length;
  if (droppedCount > 0) {
    logger.info({ droppedCount, checked: rows.length }, "Notion Inbox: dropped dead URLs");
  }

  await markRowsImported(rows.map((row) => row.pageUrl));

  return verified.map(toRawJob);
}
