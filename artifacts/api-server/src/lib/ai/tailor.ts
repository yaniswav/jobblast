// AI-powered tailoring pass: replaces the static placeholder bullets/cover
// letter (lib/sources/tailoring.ts) with content generated per-job by the
// local Claude Code CLI (lib/ai/claude-cli.ts), grounded in the user's real
// master resume. Runs serially (one CLI call at a time - it rides the
// user's Claude subscription, not a metered API key) and is safe to trigger
// repeatedly: a module-level guard makes overlapping calls a no-op.
//
// The prompt describes the applicant purely from data: the master resume and
// headline stored in the `profiles` row, the sign-off name from
// `contact.name` in jobblast.config.json, and the language rule from
// `candidate.letterLanguages` / `candidate.fallbackLetterLanguage`. No
// candidate detail is hardcoded here.

import { and, desc, eq } from "drizzle-orm";
import { db, jobListingsTable, profilesTable, type JobListing } from "@workspace/db";
import { loadConfig } from "../config";
import { logger } from "../logger";
import { getCoverLetterTemplate } from "../sources/tailoring";
import { runClaudePrompt } from "./claude-cli";

const DEFAULT_LIMIT = 10;
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

/** ISO 639-1 -> English language name, for prompts. Unknown codes pass through. */
const LANGUAGE_NAMES: Record<string, string> = {
  ar: "Arabic",
  de: "German",
  en: "English",
  es: "Spanish",
  fr: "French",
  it: "Italian",
  ja: "Japanese",
  ko: "Korean",
  nl: "Dutch",
  pl: "Polish",
  pt: "Portuguese",
  ru: "Russian",
  sv: "Swedish",
  tr: "Turkish",
  zh: "Chinese",
};

function languageName(code: string): string {
  return LANGUAGE_NAMES[code.trim().toLowerCase()] ?? code;
}

function formatList(items: string[]): string {
  if (items.length <= 1) return items[0] ?? "";
  return `${items.slice(0, -1).join(", ")} or ${items[items.length - 1]}`;
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
  const { contact, candidate } = loadConfig();

  const letterLanguages =
    candidate.letterLanguages.length > 0 ? candidate.letterLanguages : [candidate.fallbackLetterLanguage];
  const letterLanguageNames = formatList(letterLanguages.map(languageName));
  const fallbackLanguageName = languageName(candidate.fallbackLetterLanguage);

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
  job: JobListing,
  context: TailoringContext,
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

  const rawResult = await runClaudePrompt(prompt);

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

  return { bullets: parsed.bullets, coverLetter: parsed.coverLetter.trim() };
}

let passRunning = false;

/**
 * Tailors up to `limit` queued, non-seed, not-yet-AI-tailored jobs (highest
 * relevanceScore first), one CLI call at a time. Successes overwrite
 * tailoredBullets/coverLetter and set aiGenerated=true. On failure or
 * invalid output, aiGenerated is left false and the row keeps its
 * placeholder content, so the job is naturally retried on the next pass.
 *
 * No-ops (via a module-level guard) if a pass is already in progress.
 */
export async function runTailoringPass(limit: number = DEFAULT_LIMIT): Promise<void> {
  if (passRunning) {
    logger.debug("AI tailoring pass already running, skipping this trigger");
    return;
  }
  passRunning = true;

  try {
    const [profile] = await db.select().from(profilesTable).limit(1);
    if (!profile) {
      logger.warn("AI tailoring pass: no profile row found, skipping");
      return;
    }

    const jobs = await db
      .select()
      .from(jobListingsTable)
      .where(
        and(
          eq(jobListingsTable.status, "queued"),
          eq(jobListingsTable.isSeed, false),
          eq(jobListingsTable.aiGenerated, false),
        ),
      )
      .orderBy(desc(jobListingsTable.relevanceScore))
      .limit(limit);

    if (jobs.length === 0) {
      logger.debug("AI tailoring pass: no eligible jobs found");
      return;
    }

    const context: TailoringContext = {
      masterResume: profile.masterResume,
      headline: profile.headline,
      coverLetterTemplate: await getCoverLetterTemplate(),
    };

    logger.info({ count: jobs.length }, "AI tailoring pass starting");

    let succeeded = 0;
    let failed = 0;

    for (const job of jobs) {
      const startedAt = Date.now();
      try {
        const content = await generateTailoredContent(job, context);
        const ms = Date.now() - startedAt;

        if (!content) {
          failed++;
          logger.warn({ jobId: job.id, ms, ok: false }, "AI tailoring: invalid output, leaving placeholder");
          continue;
        }

        await db
          .update(jobListingsTable)
          .set({
            tailoredBullets: content.bullets,
            coverLetter: content.coverLetter,
            aiGenerated: true,
          })
          .where(eq(jobListingsTable.id, job.id));

        succeeded++;
        logger.info({ jobId: job.id, ms, ok: true }, "AI tailoring: job tailored");
      } catch (err) {
        const ms = Date.now() - startedAt;
        failed++;
        logger.error({ jobId: job.id, ms, ok: false, err }, "AI tailoring: job failed");
      }
    }

    logger.info({ succeeded, failed, total: jobs.length }, "AI tailoring pass complete");
  } finally {
    passRunning = false;
  }
}
