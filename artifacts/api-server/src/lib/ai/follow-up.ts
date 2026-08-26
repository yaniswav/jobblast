// Follow-up e-mail drafting (lot H4): "Thales, 13 days without a reply - a
// follow-up is suggested, with the e-mail pre-written" from the app's own
// vision doc.
//
// FOUNDING RULE, and the reason this file only ever returns text: JobBlast
// NEVER sends a follow-up e-mail. There is no send call anywhere in this
// module, no SMTP client, no dependency on the transactional-e-mail layer
// the rest of the app uses for its own notices (lib/email/). The draft this
// produces is copied by the user into their own mailbox, or opened via a
// mailto: link that pre-fills the subject and body and nothing else - see
// routes/applications.ts and pages/applications.tsx. See lib/follow-ups.ts
// for the separate question of WHICH applications get suggested at all
// (never one that already received a reply - gmail-sync.ts is what would
// have moved it out of "applied" the moment a reply was read).
//
// Two layers, the same "deterministic base + optional AI polish, silent
// fallback" shape as lib/sources/tailoring.ts + lib/ai/tailor.ts:
//   buildFollowUpTemplate() - always available, zero dependencies beyond the
//     application's own real data (role, company, date applied, days
//     elapsed). This is what every account gets with `ai.provider: "none"`,
//     and what any account falls back to if the AI call fails or returns
//     something unusable.
//   generateFollowUpEmail() - if a text provider is configured, asks it for
//     a warmer, personalized version grounded in the master resume and the
//     posting, with the same anti-slop rules as a cover letter. Any failure
//     (no provider, malformed output, provider error) falls back to the
//     template SILENTLY - the caller never sees an error for this, only ever
//     a usable draft.

import { loadConfig } from "../config";
import { logger } from "../logger";
import { daysSince } from "../follow-ups";
import { detectLetterLanguage, letterLanguageRule } from "./language";
import {
  disableAiForUser,
  getTextProvider,
  isProviderUnavailable,
  type TextProvider,
} from "./provider";
import { sanitizeAiText } from "./sanitize";

const DESCRIPTION_TRUNCATE_CHARS = 2000;
/** Short text generation, not a research pass - a few seconds is plenty. */
const GENERATE_TIMEOUT_MS = 45_000;
/** "100 to 150 words" in the spec, with slack either side for a model's output to still count as usable. */
const MIN_BODY_WORDS = 60;
const MAX_BODY_WORDS = 220;
const MAX_SUBJECT_CHARS = 200;

export type FollowUpEmail = { subject: string; body: string; source: "template" | "ai" };

export type FollowUpInput = {
  masterResume: string;
  headline: string;
  title: string;
  company: string;
  location: string;
  description: string;
  appliedAt: Date;
  now: Date;
};

function truncate(text: string, maxChars: number): string {
  return text.length > maxChars ? `${text.slice(0, maxChars)}...` : text;
}

// ---------------------------------------------------------------------------
// Deterministic template - always correct, never invents anything
// ---------------------------------------------------------------------------

/** "13 August 2026" in English, "13 août 2026" in French, etc. Falls back to ISO on an unrecognized locale. */
function formatAppliedDate(date: Date, language: string): string {
  const locale = language.trim() || "en";
  try {
    return new Intl.DateTimeFormat(locale, { day: "numeric", month: "long", year: "numeric" }).format(date);
  } catch {
    return date.toISOString().slice(0, 10);
  }
}

type TemplateCopy = { subject: string; body: string };

type TemplateParams = {
  title: string;
  company: string;
  appliedDate: string;
  daysElapsed: number;
  signOffName: string;
};

// Looked up by an arbitrary detected/fallback language code below, so the
// `string` index signature is load-bearing.
// eslint-disable-next-line anti-slop/no-known-value-widening
const TEMPLATES: Record<string, (params: TemplateParams) => TemplateCopy> = {
  fr: ({ title, company, appliedDate, daysElapsed, signOffName }) => ({
    subject: `Suivi de ma candidature - ${title} chez ${company}`,
    body: `Bonjour,

Je me permets de revenir vers vous au sujet de ma candidature au poste de ${title} chez ${company}, envoyée le ${appliedDate} (il y a ${daysElapsed} jours).

Je reste très intéressé(e) par ce poste et par l'opportunité de rejoindre ${company}. Si des informations complémentaires sur mon profil ou mon parcours peuvent être utiles à l'étude de ma candidature, je me tiens naturellement à votre disposition pour un échange.

Auriez-vous une visibilité sur l'avancement du processus de recrutement pour ce poste ?

Je vous remercie pour le temps que vous accordez à ma candidature et reste dans l'attente de votre retour.

Cordialement,
${signOffName}`,
  }),
  en: ({ title, company, appliedDate, daysElapsed, signOffName }) => ({
    subject: `Following up on my application - ${title} at ${company}`,
    body: `Hello,

I wanted to follow up on my application for the ${title} position at ${company}, submitted on ${appliedDate} (${daysElapsed} days ago).

I remain very interested in this role and in the opportunity to join ${company}. If any further information about my background would be useful as you review my application, I would be glad to provide it.

Could you share an update on where things stand with the recruitment process for this role?

Thank you for your time and consideration. I look forward to hearing from you.

Best regards,
${signOffName}`,
  }),
};

/**
 * The always-available draft: deterministic, built entirely from real data
 * (role, company, the actual application date, the actual days elapsed) plus
 * the sign-off name from `contact.name`. Never calls a model.
 *
 * Language: guessed from the posting text via detectLetterLanguage() (the
 * same letterLanguages/fallbackLetterLanguage rule every AI prompt in this
 * app is handed, applied here without a model to read the text - see
 * language.ts). Only French and English have bespoke copy today, matching
 * this app's own defaults; any other detected/fallback language renders the
 * English copy rather than a mistranslated guess.
 */
export function buildFollowUpTemplate(input: FollowUpInput): TemplateCopy {
  const { contact, candidate } = loadConfig();
  const letterLanguages = candidate.letterLanguages.length > 0 ? candidate.letterLanguages : [candidate.fallbackLetterLanguage];
  const language = detectLetterLanguage(`${input.title}\n${input.description}`, letterLanguages, candidate.fallbackLetterLanguage);

  const params = {
    title: input.title,
    company: input.company,
    appliedDate: formatAppliedDate(input.appliedAt, language),
    daysElapsed: daysSince(input.appliedAt, input.now),
    signOffName: contact.name.trim() || "Your Name",
  };

  const build = TEMPLATES[language.trim().toLowerCase()] ?? TEMPLATES["en"]!;
  return build(params);
}

// ---------------------------------------------------------------------------
// Optional AI polish
// ---------------------------------------------------------------------------

function buildPrompt(input: FollowUpInput): string {
  const { letterLanguageNames, fallbackLanguageName } = letterLanguageRule();
  const daysElapsed = daysSince(input.appliedAt, input.now);
  const headlineBlock = input.headline.trim() ? `APPLICANT HEADLINE: ${input.headline.trim()}\n\n` : "";

  return `You are helping a job applicant write a short, polite follow-up e-mail about a job application they already sent and have not heard back on.

${headlineBlock}MASTER RESUME (the applicant's real, full background - the only source of facts you may draw from):
"""
${input.masterResume}
"""

JOB POSTING THEY APPLIED TO:
Title: ${input.title}
Company: ${input.company}
Location: ${input.location}
Description:
"""
${truncate(input.description, DESCRIPTION_TRUNCATE_CHARS)}
"""

APPLICATION FACTS: submitted ${daysElapsed} day(s) ago, no response received since.

Produce a JSON object with exactly two keys, "subject" and "body" (the body only - no "Subject:" line inside it, no sign-off name inside it beyond what RULES below asks for).

RULES, all mandatory:
- Tone: courteous, brief, and confident. Reaffirm genuine interest in this specific role and company, briefly remind them what was applied for and when, and end with exactly ONE open, low-pressure question (for example about the process or the timeline). Never sound desperate, never apply pressure, never use guilt, never use more than one exclamation point in the whole message (zero is fine).
- Length: the body must be 100 to 150 words, not counting the subject line or the sign-off name.
- Ground every specific claim about the applicant strictly in the master resume above - never invent experience, employers, technologies or achievements.
- Sign off with the applicant's own name exactly as it appears in the master resume, on its own line at the end of the body.
- Address it generically (no named recipient) unless the posting names one.

CRITICAL - language rule: The applicant writes applications in ${letterLanguageNames}. If the job posting above is written in one of those languages, write BOTH the subject and the body in that language. For a posting in any other language, write them in ${fallbackLanguageName}. Never write in a language the applicant has not listed.

STYLE - write like a person, not a model: no em dashes or en dashes (use commas, periods or parentheses instead), straight quotes only, no ellipsis character, no bullet points, no buzzword stacking. Avoid openers like "I hope this email finds you well" in English or "Je me permets de revenir vers vous" in French; start with something specific to the role or the company.

Output STRICT JSON only, with exactly this shape and no other keys:
{"subject": "...", "body": "..."}

Do not wrap the JSON in markdown code fences. Do not include any commentary, explanation, or text before or after the JSON object. Output raw JSON only.`;
}

/** Exported for testability. */
export function wordCount(text: string): number {
  const words = text.trim().split(/\s+/).filter((word) => word.length > 0);
  return words.length;
}

/** Exported for testability. */
export function isValidFollowUpEmail(value: unknown): value is { subject: string; body: string } {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;

  const subject = candidate["subject"];
  if (typeof subject !== "string" || subject.trim().length === 0 || subject.trim().length > MAX_SUBJECT_CHARS) {
    return false;
  }

  const body = candidate["body"];
  if (typeof body !== "string") return false;
  const words = wordCount(body);
  if (words < MIN_BODY_WORDS || words > MAX_BODY_WORDS) return false;

  return true;
}

async function generateWithAi(
  input: FollowUpInput,
  provider: TextProvider,
): Promise<{ subject: string; body: string } | null> {
  const rawResult = await provider.generateText(buildPrompt(input), { timeoutMs: GENERATE_TIMEOUT_MS });

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawResult);
  } catch (err) {
    logger.warn({ err, rawResultPreview: rawResult.slice(0, 300) }, "Follow-up e-mail: model output was not valid JSON");
    return null;
  }

  if (!isValidFollowUpEmail(parsed)) {
    logger.warn(
      { parsedPreview: JSON.stringify(parsed).slice(0, 300) },
      "Follow-up e-mail: model output failed validation",
    );
    return null;
  }

  return { subject: sanitizeAiText(parsed.subject), body: sanitizeAiText(parsed.body) };
}

/**
 * The follow-up e-mail for one application: an AI-personalized version when
 * a text provider is configured and it produces something usable, otherwise
 * the deterministic template - always silently, never an error the caller
 * has to handle. See the file header for why nothing here ever sends
 * anything.
 */
export async function generateFollowUpEmail(userId: string, input: FollowUpInput): Promise<FollowUpEmail> {
  const template = buildFollowUpTemplate(input);

  const provider = await getTextProvider(userId);
  if (!provider) return { ...template, source: "template" };

  try {
    const generated = await generateWithAi(input, provider);
    if (!generated) return { ...template, source: "template" };
    return { ...generated, source: "ai" };
  } catch (err) {
    if (isProviderUnavailable(err)) {
      disableAiForUser(userId, err.message);
    }
    logger.warn({ err }, "Follow-up e-mail: AI generation failed, using the template instead");
    return { ...template, source: "template" };
  }
}
