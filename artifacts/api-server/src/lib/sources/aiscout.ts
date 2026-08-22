// "AI Scout" job source: a headless Claude agent (local `claude` CLI, riding
// the user's Claude subscription - no metered API key, $0 marginal cost)
// searches the claude.ai job connector MCP servers listed in
// `sources.aiScout.allowedConnectors` plus the live web for current job
// postings matching the profile, and feeds them into the same aggregation
// pipeline as the other sources.
//
// Exists to cover job boards / company career pages our structured-API
// sources (Greenhouse, Lever, Adzuna, France Travail...) don't reach at all,
// especially for Taiwan and Japan where API coverage is thin. Slow (a real
// connector + web-search-backed agent run, several minutes) and
// non-deterministic (LLM output), so it's throttled to at most once per 24h
// via a timestamp file (see shouldSkipDueToFrequency below) and every URL it
// returns is independently verified to be live before being handed to
// refresh.ts.

import fs from "node:fs";
import path from "node:path";
import { db, profilesTable } from "@workspace/db";
import { runClaudePrompt } from "../ai/claude-cli";
import { loadConfig } from "../config";
import { logger } from "../logger";
import { REPO_ROOT } from "../storage";
import { isHttpUrl, isNonEmptyString, parseJsonArrayResponse } from "./cli-json";
import { politeFetch } from "./http";
import type { RawJob } from "./types";

const SCOUT_STATE_FILE = path.join(REPO_ROOT, "data", "aiscout-last-run.txt");
const MIN_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24h
const CLI_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes - real web search + browsing takes a while
const URL_CHECK_TIMEOUT_MS = 10_000;

// The claude.ai "job connector" MCP servers to query, from
// `sources.aiScout.allowedConnectors` in jobblast.config.json. These are
// account-level connectors (configured via `claude mcp login` / claude.ai
// connector settings - not project config, so no --mcp-config /
// --strict-mcp-config is needed here); list yours with `claude mcp list`.
// Server names are normalized by replacing spaces/dots with underscores and
// prefixing "mcp__". Allowing the whole server (no third `__tool` segment)
// means any tool the connector exposes is usable without hardcoding tool
// names that could change server-side. A connector that is unauthorized in
// headless sessions or rate-limited is not fatal: the prompt tells the agent
// to move on, and this fetcher tolerates web-search-only results.
function allowedTools(): string {
  return [...loadConfig().sources.aiScout.allowedConnectors, "WebSearch", "WebFetch"].join(",");
}

/** The strict JSON shape we ask the agent to return per posting. */
type ScoutPosting = {
  title: string;
  company: string;
  url: string;
  location: string;
  description: string;
};

function isValidScoutPosting(value: unknown): value is ScoutPosting {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    isNonEmptyString(candidate["title"]) &&
    isNonEmptyString(candidate["company"]) &&
    isNonEmptyString(candidate["url"]) &&
    isHttpUrl(candidate["url"]) &&
    isNonEmptyString(candidate["location"]) &&
    isNonEmptyString(candidate["description"])
  );
}

/**
 * True if the last AI Scout attempt (successful or not - see markScoutRan)
 * was less than 24h ago. Reads a timestamp file under data/ rather than
 * querying job_listings for max(fetchedAt) WHERE source='AI Scout', because
 * a run that finds zero valid postings would otherwise never throttle
 * (nothing gets inserted, so there's no row to check the age of).
 */
function shouldSkipDueToFrequency(): boolean {
  let raw: string;
  try {
    raw = fs.readFileSync(SCOUT_STATE_FILE, "utf8");
  } catch {
    return false; // no state file yet -> never run before -> don't skip
  }

  const lastRunMs = Date.parse(raw.trim());
  if (Number.isNaN(lastRunMs)) return false;

  const elapsedMs = Date.now() - lastRunMs;
  return elapsedMs < MIN_INTERVAL_MS;
}

/** Records "the scout attempted a run just now", regardless of outcome. */
function markScoutRan(): void {
  try {
    fs.mkdirSync(path.dirname(SCOUT_STATE_FILE), { recursive: true });
    fs.writeFileSync(SCOUT_STATE_FILE, new Date().toISOString(), "utf8");
  } catch (err) {
    logger.warn({ err }, "AI Scout: failed to write last-run timestamp file");
  }
}

/**
 * Builds the scout prompt entirely from data: the DB profile describes the
 * candidate (headline, target roles, target locations) and
 * `sources.aiScout` supplies the optional company/site shortlists.
 */
function buildPrompt(params: {
  headline: string;
  masterResume: string;
  targetRoles: string[];
  targetLocations: string[];
}): string {
  const { headline, masterResume, targetRoles, targetLocations } = params;
  const { allowedConnectors, targetCompanies, targetSites, maxPostings } = loadConfig().sources.aiScout;

  const connectorNames = allowedConnectors.join(", ") || "(none configured)";
  const locations = targetLocations.length > 0 ? `${targetLocations.join(", ")}, or fully remote` : "fully remote";
  const profileBlock = [
    headline.trim() ? `Candidate profile: ${headline.trim()}` : "",
    targetRoles.length > 0 ? `Target roles: ${targetRoles.join(", ")}` : "",
    `Target locations: ${locations}`,
    masterResume.trim() ? `Background (the only source of facts about the candidate):\n"""\n${masterResume.trim()}\n"""` : "",
  ]
    .filter((line) => line.length > 0)
    .join("\n");

  const companiesLine =
    targetCompanies.length > 0
      ? `\n   - Also check the career pages of these companies specifically: ${targetCompanies.join(", ")}.`
      : "";
  const sitesLine =
    targetSites.length > 0
      ? ` Prioritize these job boards / sites: ${targetSites.join(", ")}.`
      : "";

  return `You are a job-search scout. Find CURRENT, REAL, individual job postings that match this candidate profile:

${profileBlock}

You have two kinds of tools - use BOTH, in this order:

1. FIRST, query your job connector MCP tools (${connectorNames}). Run searches on each of them for terms matching the profile above, including location-scoped searches for the target locations where the connector supports it. These connectors are account-level tools the user has already authorized - actually call them, don't just describe them.
   - Treat each connector independently: if one errors, times out, requires re-authorization, or is rate-limited, note it internally and move on to the next one. NEVER stop or fail the whole task because one connector didn't work - just use however many of them actually respond.
   - A connector may have no coverage at all in some target locations - that's expected, don't spend excessive effort forcing matches there.

2. THEN, use WebSearch / WebFetch to fill the gaps, especially in target locations your connectors don't cover. Search job boards and company career pages directly.${sitesLine}${companiesLine}

Combine results from both steps into one list, preferring the strongest overall matches to the profile if you have more than ${maxPostings} candidates.

Return up to ${maxPostings} postings as STRICT JSON: an array of objects, each shaped exactly like this:
{"title": "...", "company": "...", "url": "...", "location": "...", "description": "..."}

Rules, all mandatory:
- "url" must be the DIRECT URL of one specific job posting - never a search-results page, a category/listing page, or a job board's homepage.
- "description" must be a 2-4 sentence summary of the posting's actual requirements (skills, experience level), written from the real posting content.
- Every posting must be a REAL, CURRENTLY OPEN listing you actually found via a tool call (connector or web). Do NOT invent, guess, or hallucinate postings, companies, or URLs. If you are not confident a posting is real and currently open, OMIT it rather than include it.
- If you find fewer than ${maxPostings} genuine matching postings, return fewer. An empty array is a valid and acceptable answer if you find nothing real that matches.

Output ONLY the raw JSON array, no markdown code fences, no commentary before or after it.`;
}

/**
 * Fetches the live profile, asks the headless Claude CLI (with the job
 * connector MCP tools plus web search / fetch enabled) to scout current job
 * postings, validates the response, verifies every returned URL actually
 * resolves, and maps survivors to RawJob[] with source "AI Scout".
 *
 * Throttled to at most once per 24h (see shouldSkipDueToFrequency). Never
 * throws - any failure (frequency skip, missing profile, CLI error, bad
 * JSON, all postings invalid) is logged and results in an empty array, same
 * as every other source fetcher in the allSettled pipeline in refresh.ts.
 */
export async function fetchAiScoutJobs(): Promise<RawJob[]> {
  if (shouldSkipDueToFrequency()) {
    logger.info("AI Scout: skipped, last run was under 24h ago");
    return [];
  }

  const [profile] = await db.select().from(profilesTable).limit(1);
  if (!profile) {
    logger.warn("AI Scout: no profile row found, skipping");
    return [];
  }

  // Mark the attempt now (before the slow CLI call) so a crash mid-run, or a
  // second refresh cycle firing while this one is still in flight, doesn't
  // cause back-to-back scout runs.
  markScoutRan();

  const { maxPostings, effortLevel } = loadConfig().sources.aiScout;

  const prompt = buildPrompt({
    headline: profile.headline,
    masterResume: profile.masterResume,
    targetRoles: profile.targetRoles,
    targetLocations: profile.targetLocations,
  });

  let rawResult: string;
  const startedAt = Date.now();
  try {
    rawResult = await runClaudePrompt(prompt, {
      timeoutMs: CLI_TIMEOUT_MS,
      // --effort: this run is slow and infrequent (throttled to 1/24h) and
      // the quality of the returned postings matters more than latency, so
      // the default is "high" (see `sources.aiScout.effortLevel`).
      extraArgs: ["--allowedTools", allowedTools(), "--effort", effortLevel],
    });
  } catch (err) {
    logger.error({ err, ms: Date.now() - startedAt }, "AI Scout: Claude CLI call failed");
    return [];
  }
  logger.info({ ms: Date.now() - startedAt }, "AI Scout: Claude CLI call completed");

  const parsed = parseJsonArrayResponse(rawResult);
  if (!parsed) {
    logger.warn(
      { rawResultPreview: rawResult.slice(0, 500) },
      "AI Scout: model output was not (or did not contain) a valid JSON array",
    );
    return [];
  }

  const candidates = parsed.filter(isValidScoutPosting).slice(0, maxPostings);
  const invalidCount = parsed.length - candidates.length;
  if (invalidCount > 0) {
    logger.warn({ invalidCount, total: parsed.length }, "AI Scout: dropped malformed postings");
  }

  if (candidates.length === 0) {
    logger.info("AI Scout: no valid postings after JSON validation");
    return [];
  }

  // URL validation pass: the model can return dead/stale links despite
  // instructions not to. Verify each one actually resolves before handing
  // it to the aggregation pipeline.
  const verified: ScoutPosting[] = [];
  for (const posting of candidates) {
    try {
      const res = await politeFetch(posting.url, { method: "GET" }, URL_CHECK_TIMEOUT_MS);
      if (res.ok || (res.status >= 300 && res.status < 400)) {
        verified.push(posting);
      } else {
        logger.debug({ url: posting.url, status: res.status }, "AI Scout: dropping dead URL");
      }
    } catch (err) {
      logger.debug({ url: posting.url, err }, "AI Scout: URL check errored, dropping");
    }
  }
  const droppedCount = candidates.length - verified.length;
  if (droppedCount > 0) {
    logger.info({ droppedCount, checked: candidates.length }, "AI Scout: dropped dead URLs");
  }

  const postedDate = new Date().toISOString().slice(0, 10);
  return verified.map((posting) => ({
    source: "AI Scout",
    title: posting.title,
    company: posting.company,
    location: posting.location,
    url: posting.url,
    description: posting.description,
    postedDate,
    salaryRange: null,
  }));
}
