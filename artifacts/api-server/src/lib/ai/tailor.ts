// AI-powered tailoring pass: replaces the static placeholder bullets/cover
// letter (lib/sources/tailoring.ts) with content generated per-job by
// whichever AI provider is configured (lib/ai/provider.ts - Claude Code CLI
// by default), grounded in the user's real master resume. Runs serially (one
// call at a time) and is safe to trigger repeatedly: a module-level guard
// makes overlapping calls a no-op.
//
// The whole pass is optional. With `ai.provider: "none"`, or once a provider
// has reported itself unreachable on this machine, getTextProvider() returns
// null and every job simply keeps the template letter and profile-derived
// bullets it already has (the UI shows them as a template draft).
//
// The prompt describes the applicant purely from data: the master resume and
// headline stored in the `profiles` row, the sign-off name from
// `contact.name` in jobblast.config.json, and the language rule from
// `candidate.letterLanguages` / `candidate.fallbackLetterLanguage`. No
// candidate detail is hardcoded here.

import { loadConfig } from "../config";
import { logger } from "../logger";
import {
  getUserPosting,
  listUntailoredPostings,
  saveTailoredContent,
  type UserPostingRow,
} from "../repo/postings";
import { getProfile } from "../repo/profile";
import { getCoverLetterTemplate } from "../sources/tailoring";
import { letterLanguageRule } from "./language";
import {
  configuredProviderName,
  disableAiForUser,
  getTextProvider,
  isProviderUnavailable,
  type TextProvider,
} from "./provider";
import { sanitizeAiText, sanitizeAiTexts } from "./sanitize";

const DEFAULT_LIMIT = 10;
/**
 * How many times one job may be attempted over this process's lifetime.
 * A small local model that keeps returning malformed JSON for one awkward
 * posting would otherwise be retried on it every 30 minutes forever, and
 * crowd out jobs that would have succeeded.
 */
const MAX_ATTEMPTS_PER_JOB = 3;
const DESCRIPTION_TRUNCATE_CHARS = 4000;
const BULLET_COUNT = 4;
const MIN_COVER_LETTER_CHARS = 800;
const MAX_COVER_LETTER_CHARS = 3500;

type TailoredContent = {
  bullets: string[];
  coverLetter: string;
};

function truncate(text: string, maxChars: number): string {
  return text.length > maxChars ? `${text.slice(0, maxChars)}…` : text;
}

function buildPrompt(params: {
  masterResume: string;
  headline: string;
  coverLetterTemplate: string;
  title: string;
  company: string;
  location: string;
  description: string;
}): string {
  const { masterResume, headline, coverLetterTemplate, title, company, location, description } = params;
  const { contact } = loadConfig();
  const { letterLanguageNames, fallbackLanguageName } = letterLanguageRule();

  const signOffName = contact.name.trim();
  const signOffRule = signOffName
    ? `Sign off as "${signOffName}" (or the equivalent sign-off used in the reference template, e.g. "Yours faithfully,\\n${signOffName}").`
    : "Sign off with the applicant's own name exactly as it appears in the master resume, using the sign-off phrasing of the reference template.";

  const headlineBlock = headline.trim() ? `APPLICANT HEADLINE: ${headline.trim()}\n\n` : "";

  return `You are helping a job applicant tailor their resume bullets and cover letter for one specific job posting.

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

REFERENCE COVER LETTER TEMPLATE (match this structure, tone, and sign-off style, but rewrite the content to be specific to this job):
"""
${coverLetterTemplate}
"""

Produce two things:

1. "bullets": exactly ${BULLET_COUNT} punchy, job-specific resume bullets. Each bullet must be drawn ONLY from facts, skills, or experience actually present in the master resume above - never invent experience, employers, technologies, or achievements that aren't in the master resume. Order them most-relevant-to-this-job first. Each bullet should read as a polished resume line (no bullet symbol, no trailing period requirement, action-oriented).

2. "coverLetter": a ${MIN_COVER_LETTER_CHARS}-${MAX_COVER_LETTER_CHARS} character cover letter (roughly 250-350 words), following the same overall structure and tone as the reference template above, but tailored specifically to this job and company. Address it generically ("Dear Hiring Team" or the equivalent generic greeting in the posting's language - do not address a named person). ${signOffRule}

CRITICAL - language rule: The applicant writes applications in ${letterLanguageNames}. If the job posting is written in one of those languages, write BOTH the cover letter and the bullets in that language. For a posting in any other language, write them in ${fallbackLanguageName} - you may open the letter with one short greeting sentence in the posting's language, then continue in ${fallbackLanguageName}. Never write an application in a language the applicant has not listed: doing so would misrepresent them.

STYLE - write like a person, not a model: no em dashes or en dashes (use commas, periods or parentheses instead), straight quotes only, no ellipsis character, no bullet symbols inside the letter, no buzzword stacking, vary sentence length. Avoid openers like "I am writing to express my interest" in English or "C'est avec un vif intérêt" in French; start with something specific to the company or role.

Output STRICT JSON only, with exactly this shape and no other keys:
{"bullets": ["...", "...", "...", "..."], "coverLetter": "..."}

Do not wrap the JSON in markdown code fences. Do not include any commentary, explanation, or text before or after the JSON object. Output raw JSON only.`;
}

function isValidTailoredContent(value: unknown): value is TailoredContent {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;

  if (!Array.isArray(candidate["bullets"])) return false;
  const bullets = candidate["bullets"];
  if (bullets.length !== BULLET_COUNT) return false;
  if (!bullets.every((b) => typeof b === "string" && b.trim().length > 0)) return false;

  const coverLetter = candidate["coverLetter"];
  if (typeof coverLetter !== "string") return false;
  const len = coverLetter.trim().length;
  if (len < MIN_COVER_LETTER_CHARS || len > MAX_COVER_LETTER_CHARS) return false;

  return true;
}

/** Calls the Claude CLI once for `job` and returns validated tailored content, or null if invalid. */
type TailoringContext = {
  masterResume: string;
  headline: string;
  coverLetterTemplate: string;
};

async function generateTailoredContent(
  job: UserPostingRow,
  context: TailoringContext,
  provider: TextProvider,
): Promise<TailoredContent | null> {
  const prompt = buildPrompt({
    masterResume: context.masterResume,
    headline: context.headline,
    coverLetterTemplate: context.coverLetterTemplate,
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
      "AI tailoring: model output was not valid JSON",
    );
    return null;
  }

  if (!isValidTailoredContent(parsed)) {
    logger.warn(
      { jobId: job.id, parsedPreview: JSON.stringify(parsed).slice(0, 300) },
      "AI tailoring: model output failed validation",
    );
    return null;
  }

  return { bullets: sanitizeAiTexts(parsed.bullets), coverLetter: sanitizeAiText(parsed.coverLetter) };
}

// All three of these are keyed by account: postings are shared platform-wide,
// so a bare posting id would let one account's retry budget be spent by
// another, and a bare boolean would let one account's pass block everybody
// else's. With one account (selfhosted) this is exactly the old behavior.
const passRunningFor = new Set<string>();
/** "<userId>:<postingId>" -> failed attempts so far, this process. See MAX_ATTEMPTS_PER_JOB. */
const attemptsByJob = new Map<string, number>();
const noAiNoticeLoggedFor = new Set<string>();

function attemptKey(userId: string, postingId: number): string {
  return `${userId}:${postingId}`;
}

function noteNoAiOnce(userId: string): void {
  if (noAiNoticeLoggedFor.has(userId)) return;
  noAiNoticeLoggedFor.add(userId);
  logger.info(
    { provider: configuredProviderName() },
    "AI disabled: letters use the template + profile-derived bullets",
  );
}

/**
 * Tailors up to `limit` queued, non-seed, not-yet-AI-tailored jobs (highest
 * relevanceScore first), one provider call at a time. Successes overwrite
 * tailoredBullets/coverLetter and set aiGenerated=true. On failure or
 * invalid output, aiGenerated is left false and the row keeps its
 * placeholder content, so the job is retried on the next pass - up to
 * MAX_ATTEMPTS_PER_JOB times per process.
 *
 * No-ops (via a module-level guard) if a pass is already in progress, and
 * no-ops entirely when no text provider is configured or available.
 */
export async function runTailoringPass(
  userId: string,
  limit: number = DEFAULT_LIMIT,
): Promise<void> {
  if (passRunningFor.has(userId)) {
    logger.debug("AI tailoring pass already running, skipping this trigger");
    return;
  }

  const provider = await getTextProvider(userId);
  if (!provider) {
    noteNoAiOnce(userId);
    return;
  }

  passRunningFor.add(userId);

  try {
    const profile = await getProfile(userId);
    if (!profile) {
      logger.warn("AI tailoring pass: no profile row found, skipping");
      return;
    }

    const jobs = await listUntailoredPostings(userId, limit);

    // Jobs this process has already failed MAX_ATTEMPTS_PER_JOB times keep
    // their template content and are not tried again until a restart.
    const eligible = jobs.filter(
      (job) => (attemptsByJob.get(attemptKey(userId, job.id)) ?? 0) < MAX_ATTEMPTS_PER_JOB,
    );
    const exhausted = jobs.length - eligible.length;
    if (exhausted > 0) {
      logger.debug({ exhausted }, "AI tailoring pass: skipping jobs that hit the per-job retry cap");
    }

    if (eligible.length === 0) {
      logger.debug("AI tailoring pass: no eligible jobs found");
      return;
    }

    const context: TailoringContext = {
      masterResume: profile.masterResume,
      headline: profile.headline,
      coverLetterTemplate: await getCoverLetterTemplate(userId),
    };

    logger.info({ count: eligible.length, provider: provider.name }, "AI tailoring pass starting");

    let succeeded = 0;
    let failed = 0;

    for (const job of eligible) {
      const startedAt = Date.now();
      try {
        const content = await generateTailoredContent(job, context, provider);
        const ms = Date.now() - startedAt;

        if (!content) {
          failed++;
          bumpAttempts(userId, job.id);
          logger.warn({ jobId: job.id, ms, ok: false }, "AI tailoring: invalid output, leaving placeholder");
          continue;
        }

        await saveTailoredContent(userId, job.id, content);

        succeeded++;
        attemptsByJob.delete(attemptKey(userId, job.id));
        logger.info({ jobId: job.id, ms, ok: true }, "AI tailoring: job tailored");
      } catch (err) {
        const ms = Date.now() - startedAt;
        failed++;

        // "This provider can never work for this account" (CLI not installed,
        // API key unset or rejected, local server down): stop the pass and
        // fall back to template letters for this account, rather than
        // repeating the same error for every remaining job every 30 minutes.
        // Another account's pass is unaffected.
        if (isProviderUnavailable(err)) {
          disableAiForUser(userId, err.message);
          logger.error({ jobId: job.id, ms, ok: false, err }, "AI tailoring: provider unavailable, aborting pass");
          break;
        }

        bumpAttempts(userId, job.id);
        logger.error({ jobId: job.id, ms, ok: false, err }, "AI tailoring: job failed");
      }
    }

    logger.info({ succeeded, failed, total: eligible.length }, "AI tailoring pass complete");
  } finally {
    passRunningFor.delete(userId);
  }
}

function bumpAttempts(userId: string, postingId: number): void {
  const key = attemptKey(userId, postingId);
  attemptsByJob.set(key, (attemptsByJob.get(key) ?? 0) + 1);
}

/**
 * Tailors exactly one posting, now, for one account: the `user.tailor` job
 * kind, which in `saas` is the ONLY way a letter gets written.
 *
 * Mass tailoring spends the user's own metered budget on 150 letters they
 * will never open (docs/SAAS-ARCHITECTURE.md section 6, "the one behavior
 * change worth calling out"), so in saas the pass above never runs and this
 * is enqueued when the user asks for that specific letter. Self-hosted keeps
 * the eager pass, because a CLI subscription costs nothing marginal.
 *
 * Returns whether a letter was actually written. Throws only for a provider
 * failure, so the queue can retry it with backoff.
 */
export async function tailorOnePosting(userId: string, postingId: number): Promise<boolean> {
  const provider = await getTextProvider(userId);
  if (!provider) {
    noteNoAiOnce(userId);
    return false;
  }

  const job = await getUserPosting(userId, postingId);
  if (!job) {
    logger.warn({ postingId }, "On-demand tailoring: no such posting for this account");
    return false;
  }

  const profile = await getProfile(userId);
  if (!profile) {
    logger.warn("On-demand tailoring: no profile row found, skipping");
    return false;
  }

  const context: TailoringContext = {
    masterResume: profile.masterResume,
    headline: profile.headline,
    coverLetterTemplate: await getCoverLetterTemplate(userId),
  };

  const startedAt = Date.now();
  try {
    const content = await generateTailoredContent(job, context, provider);
    if (!content) {
      logger.warn({ jobId: job.id }, "On-demand tailoring: invalid output, leaving placeholder");
      return false;
    }
    await saveTailoredContent(userId, job.id, content);
    logger.info({ jobId: job.id, ms: Date.now() - startedAt, ok: true }, "On-demand tailoring: letter written");
    return true;
  } catch (err) {
    if (isProviderUnavailable(err)) {
      disableAiForUser(userId, err.message);
    }
    throw err;
  }
}
