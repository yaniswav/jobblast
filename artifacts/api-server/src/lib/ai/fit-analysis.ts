// AI-powered fit-analysis pass: for each queued, non-seed job listing that
// hasn't been analyzed yet, asks whichever AI provider is configured (see
// lib/ai/provider.ts) to weigh the posting against the user's master resume
// and return a verdict plus concrete green flags / red flags / gaps, shown
// in the review queue as the "Fit analysis" panel.
//
// Mirrors lib/ai/tailor.ts's shape on purpose: strict JSON output via
// JSON.parse + shape validation, sanitized strings, a per-job retry cap, a
// module-level running guard, and a no-op when no text provider is
// configured (`ai.provider: "none"`, or once the provider has reported
// itself unreachable). Also skipped entirely when `ai.fitAnalysis.enabled`
// is false, so cover-letter tailoring can stay on while this is off.
//
// Runs serially - one provider call at a time - and is meant to be triggered
// AFTER runTailoringPass() finishes (src/index.ts), never in parallel with
// it, so at most one CLI/API call for this job pipeline is ever in flight.
//
// The prompt describes the applicant purely from data: the master resume and
// headline stored in the `profiles` row, and the language rule from
// `candidate.letterLanguages` / `candidate.fallbackLetterLanguage` (shared
// with tailor.ts via lib/ai/language.ts). No candidate detail is hardcoded
// here, and the model is explicitly told never to invent resume facts.

import type { FitAnalysis, FitVerdict } from "@workspace/db";
import { loadConfig } from "../config";
import { logger } from "../logger";
import { quotaCapFor } from "../quota-config";
import {
  listUnanalyzedPostings,
  saveFitAnalysis,
  type UserPostingRow,
} from "../repo/postings";
import { getProfile } from "../repo/profile";
import { selectResumeForPosting } from "../repo/resumes";
import { tryConsumeQuota } from "../repo/usage";
import { letterLanguageRule } from "./language";
import {
  configuredProviderName,
  disableAiForUser,
  getTextProvider,
  isProviderUnavailable,
  type TextProvider,
} from "./provider";
import { sanitizeAiTexts } from "./sanitize";

const DEFAULT_LIMIT = 10;
/** Same rationale as tailor.ts's MAX_ATTEMPTS_PER_JOB: cap retries per process. */
const MAX_ATTEMPTS_PER_JOB = 3;
const DESCRIPTION_TRUNCATE_CHARS = 4000;
const MIN_GREEN_FLAGS = 3;
const MAX_GREEN_FLAGS = 5;
const MAX_RED_FLAGS = 4;
const MAX_GAPS = 4;

const VERDICTS: readonly FitVerdict[] = ["strong", "good", "stretch", "poor"];

function truncate(text: string, maxChars: number): string {
  return text.length > maxChars ? `${text.slice(0, maxChars)}…` : text;
}

function buildPrompt(params: {
  masterResume: string;
  headline: string;
  title: string;
  company: string;
  location: string;
  description: string;
}): string {
  const { masterResume, headline, title, company, location, description } = params;
  const { letterLanguageNames, fallbackLanguageName } = letterLanguageRule();

  const headlineBlock = headline.trim() ? `APPLICANT HEADLINE: ${headline.trim()}\n\n` : "";

  return `You are helping a job applicant judge how well their real background fits one specific job posting, so they can decide whether it is worth their time before applying.

${headlineBlock}MASTER RESUME (the applicant's real, full background - the only source of facts you may draw from):
"""
${masterResume}
"""

JOB POSTING:
Title: ${title}
Company: ${company}
Location: ${location}
Description:
"""
${truncate(description, DESCRIPTION_TRUNCATE_CHARS)}
"""

Produce a fit analysis with exactly these parts:

1. "verdict": one of "strong", "good", "stretch", "poor" - your honest overall read of how well the master resume fits THIS posting specifically.

2. "greenFlags": ${MIN_GREEN_FLAGS} to ${MAX_GREEN_FLAGS} concrete strengths that make this a good match. Each one must connect something specific in the master resume to something specific this posting asks for (not generic praise like "strong candidate"). Order most-important first.

3. "redFlags": 0 to ${MAX_RED_FLAGS} real concerns about this posting for this applicant: seniority mismatch, visa/work-authorization or location friction, missing must-have requirements, or anything else that would genuinely give the applicant pause. Leave the array empty if there are none worth flagging. Never invent a concern just to fill the quota.

4. "gaps": 0 to ${MAX_GAPS} skills or requirements the posting asks for that are absent from the master resume. Leave the array empty if the resume already covers everything the posting asks for.

CRITICAL - grounding rule: every item in greenFlags, redFlags and gaps must be traceable to the master resume and/or the job posting text above. NEVER invent experience, employers, technologies, achievements, or requirements that are not actually present in the resume or the posting.

CRITICAL - language rule: The applicant writes applications in ${letterLanguageNames}. If the job posting is written in one of those languages, write every string (all of greenFlags, redFlags, gaps) in that language. For a posting in any other language, write them in ${fallbackLanguageName}. Never write in a language the applicant has not listed.

STYLE: short, concrete phrases, not full paragraphs. No em dashes or en dashes (use commas or parentheses instead), straight quotes only, no bullet symbols inside the strings themselves.

Output STRICT JSON only, with exactly this shape and no other keys:
{"verdict": "good", "greenFlags": ["...", "...", "..."], "redFlags": ["..."], "gaps": []}

Do not wrap the JSON in markdown code fences. Do not include any commentary, explanation, or text before or after the JSON object. Output raw JSON only.`;
}

function isValidFitAnalysis(value: unknown): value is FitAnalysis {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;

  const verdict = candidate["verdict"];
  if (typeof verdict !== "string" || !VERDICTS.includes(verdict as FitVerdict)) return false;

  const greenFlags = candidate["greenFlags"];
  if (!Array.isArray(greenFlags)) return false;
  if (greenFlags.length < MIN_GREEN_FLAGS || greenFlags.length > MAX_GREEN_FLAGS) return false;
  if (!greenFlags.every((f) => typeof f === "string" && f.trim().length > 0)) return false;

  const redFlags = candidate["redFlags"];
  if (!Array.isArray(redFlags)) return false;
  if (redFlags.length > MAX_RED_FLAGS) return false;
  if (!redFlags.every((f) => typeof f === "string" && f.trim().length > 0)) return false;

  const gaps = candidate["gaps"];
  if (!Array.isArray(gaps)) return false;
  if (gaps.length > MAX_GAPS) return false;
  if (!gaps.every((f) => typeof f === "string" && f.trim().length > 0)) return false;

  return true;
}

/**
 * Lot I3: `masterResume` is passed separately from the rest of the context -
 * it is selected per job (lib/repo/resumes.ts's selectResumeForPosting)
 * while headline is the same for every job in a pass.
 */
type FitAnalysisContext = {
  headline: string;
};

/** Calls the configured provider once for `job` and returns validated fit analysis, or null if invalid. */
async function generateFitAnalysis(
  job: UserPostingRow,
  masterResume: string,
  context: FitAnalysisContext,
  provider: TextProvider,
): Promise<FitAnalysis | null> {
  const prompt = buildPrompt({
    masterResume,
    headline: context.headline,
    title: job.title,
    company: job.company,
    location: job.location,
    description: job.description,
  });

  const rawResult = await provider.generateText(prompt);

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawResult);
  } catch (err) {
    logger.warn(
      { jobId: job.id, err, rawResultPreview: rawResult.slice(0, 300) },
      "AI fit analysis: model output was not valid JSON",
    );
    return null;
  }

  if (!isValidFitAnalysis(parsed)) {
    logger.warn(
      { jobId: job.id, parsedPreview: JSON.stringify(parsed).slice(0, 300) },
      "AI fit analysis: model output failed validation",
    );
    return null;
  }

  return {
    verdict: parsed.verdict,
    greenFlags: sanitizeAiTexts(parsed.greenFlags),
    redFlags: sanitizeAiTexts(parsed.redFlags),
    gaps: sanitizeAiTexts(parsed.gaps),
  };
}

// Keyed by account for the same reason as lib/ai/tailor.ts: postings are
// shared platform-wide, so one account must not spend another's retry budget
// or block its pass. One account (selfhosted) behaves exactly as before.
const passRunningFor = new Set<string>();
/** "<userId>:<postingId>" -> failed attempts so far, this process. See MAX_ATTEMPTS_PER_JOB. */
const attemptsByJob = new Map<string, number>();
const noAiNoticeLoggedFor = new Set<string>();

function attemptKey(userId: string, postingId: number): string {
  return `${userId}:${postingId}`;
}

function bumpAttempts(userId: string, postingId: number): void {
  const key = attemptKey(userId, postingId);
  attemptsByJob.set(key, (attemptsByJob.get(key) ?? 0) + 1);
}

/**
 * Analyzes up to `limit` queued, non-seed, not-yet-analyzed jobs (highest
 * relevanceScore first), one provider call at a time. Successes write
 * fitAnalysis + fitAnalyzedAt. On failure or invalid output, fitAnalysis is
 * left null so the job is retried on the next pass - up to
 * MAX_ATTEMPTS_PER_JOB times per process.
 *
 * No-ops (via a module-level guard) if a pass is already in progress, when
 * `ai.fitAnalysis.enabled` is false, and when no text provider is configured
 * or available.
 */
export async function runFitAnalysisPass(
  userId: string,
  limit: number = DEFAULT_LIMIT,
): Promise<void> {
  if (passRunningFor.has(userId)) {
    logger.debug("AI fit-analysis pass already running, skipping this trigger");
    return;
  }

  if (!loadConfig().ai.fitAnalysis.enabled) {
    logger.debug("AI fit-analysis pass disabled via config (ai.fitAnalysis.enabled=false)");
    return;
  }

  const provider = await getTextProvider(userId);
  if (!provider) {
    if (!noAiNoticeLoggedFor.has(userId)) {
      noAiNoticeLoggedFor.add(userId);
      logger.info(
        { provider: configuredProviderName() },
        "AI disabled: fit analysis skipped, jobs show no red/green flags",
      );
    }
    return;
  }

  passRunningFor.add(userId);

  try {
    const profile = await getProfile(userId);
    if (!profile) {
      logger.warn("AI fit-analysis pass: no profile row found, skipping");
      return;
    }

    const jobs = await listUnanalyzedPostings(userId, limit);

    // Jobs this process has already failed MAX_ATTEMPTS_PER_JOB times stay
    // unanalyzed and are not tried again until a restart.
    const eligible = jobs.filter(
      (job) => (attemptsByJob.get(attemptKey(userId, job.id)) ?? 0) < MAX_ATTEMPTS_PER_JOB,
    );
    const exhausted = jobs.length - eligible.length;
    if (exhausted > 0) {
      logger.debug({ exhausted }, "AI fit-analysis pass: skipping jobs that hit the per-job retry cap");
    }

    if (eligible.length === 0) {
      logger.debug("AI fit-analysis pass: no eligible jobs found");
      return;
    }

    const context: FitAnalysisContext = { headline: profile.headline };

    logger.info({ count: eligible.length, provider: provider.name }, "AI fit-analysis pass starting");

    let succeeded = 0;
    let failed = 0;

    const cap = quotaCapFor("fit");

    for (const job of eligible) {
      // Checked before the provider call, never after (docs/SAAS-ARCHITECTURE.md
      // section 5). Exceeding the daily cap is not an error: the remaining
      // postings simply stay unanalyzed and are picked up by tomorrow's pass.
      const quota = await tryConsumeQuota(userId, "fit", cap);
      if (!quota.allowed) {
        logger.info({ used: quota.used, cap: quota.cap }, "AI fit-analysis pass: daily quota reached, deferring the rest to tomorrow");
        break;
      }

      const startedAt = Date.now();
      try {
        // Lot I3: the resume selected for THIS job. See tailor.ts's own
        // comment on selectResumeForPosting for the golden-rule note.
        const selected = await selectResumeForPosting(userId, { title: job.title, description: job.description });
        const masterResume = selected?.content ?? profile.masterResume;
        const analysis = await generateFitAnalysis(job, masterResume, context, provider);
        const ms = Date.now() - startedAt;

        if (!analysis) {
          failed++;
          bumpAttempts(userId, job.id);
          logger.warn({ jobId: job.id, ms, ok: false }, "AI fit analysis: invalid output, leaving unanalyzed");
          continue;
        }

        await saveFitAnalysis(userId, job.id, analysis);

        succeeded++;
        attemptsByJob.delete(attemptKey(userId, job.id));
        logger.info({ jobId: job.id, ms, ok: true, verdict: analysis.verdict }, "AI fit analysis: job analyzed");
      } catch (err) {
        const ms = Date.now() - startedAt;
        failed++;

        // "This provider can never work for this account": stop the pass
        // rather than repeating the same error for every remaining job every
        // 30 minutes. Shared with tailor.ts - once disabled, both passes fall
        // back to doing nothing FOR THAT ACCOUNT, and only that one.
        if (isProviderUnavailable(err)) {
          disableAiForUser(userId, err.message);
          logger.error({ jobId: job.id, ms, ok: false, err }, "AI fit analysis: provider unavailable, aborting pass");
          break;
        }

        bumpAttempts(userId, job.id);
        logger.error({ jobId: job.id, ms, ok: false, err }, "AI fit analysis: job failed");
      }
    }

    logger.info({ succeeded, failed, total: eligible.length }, "AI fit-analysis pass complete");
  } finally {
    passRunningFor.delete(userId);
  }
}
