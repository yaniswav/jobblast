// Placeholder tailored content for fetched job listings: resume bullets
// derived from the DB profile, plus a cover letter built from the reference
// template with a one-line header naming the role. This is NOT AI-generated
// - it's a deterministic draft so the review queue / application flow keeps
// working end to end until the AI tailoring pass (lib/ai/tailor.ts) replaces
// it. Users should still review and edit both before applying.
//
// Nothing here is hardcoded to a particular candidate: the bullets come from
// `profiles.headline` / `profiles.masterResume`, and the reference cover
// letter comes from (in order) the file named by `coverLetterTemplatePath`
// in jobblast.config.json, the text of the uploaded cover_letter document,
// or a neutral built-in placeholder.

import fs from "node:fs";
import { coverLetterTemplatePath } from "../config";
import { getDocument } from "../repo/documents";
import { logger } from "../logger";
import { BoundedCache } from "../lru";
import { extractPdfTextFromBuffer } from "../pdf-text";

const MIN_BULLETS = 3;
const MAX_BULLETS = 4;
const MIN_SENTENCE_CHARS = 24;

/** Shown when the profile has nothing usable yet. */
const PLACEHOLDER_BULLETS: string[] = [
  "Placeholder bullet - add your master resume in Profile (or upload your CV) so these reflect your real experience.",
  "The AI tailoring pass replaces these with job-specific bullets once it runs.",
  "Review and edit every bullet before applying.",
];

/** Neutral fallback used when no template file and no uploaded letter exist. */
export const BUILT_IN_COVER_LETTER_TEMPLATE = `Dear Hiring Team,

I am writing to apply for this role. My background lines up closely with what
the posting describes, and I would welcome the chance to contribute to your
team.

In my most recent experience I worked on projects that required the core
skills listed in this posting, delivering them end to end and collaborating
closely with the people around me.

I would be glad to discuss how my background could be useful to your team.
Thank you for your consideration.

Yours faithfully,`;

/** Splits a free-text resume into sentence-sized bullet candidates. */
function resumeSentences(masterResume: string): string[] {
  return masterResume
    .split(/(?<=[.!?])\s+/)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence.length >= MIN_SENTENCE_CHARS);
}

export type BulletProfile = {
  headline: string;
  masterResume: string;
};

/**
 * Builds placeholder bullets for a job from the matched skills plus the
 * profile's own words. Deterministic, never invents anything.
 */
export function tailoredBulletsFor(highlightedSkills: string[], profile: BulletProfile): string[] {
  const bullets: string[] = [];

  if (highlightedSkills.length > 0) {
    bullets.push(`Matches this posting on: ${highlightedSkills.slice(0, 6).join(", ")}.`);
  }

  const headline = profile.headline.trim();
  if (headline.length > 0) bullets.push(headline);

  for (const sentence of resumeSentences(profile.masterResume)) {
    if (bullets.length >= MAX_BULLETS) break;
    if (!bullets.includes(sentence)) bullets.push(sentence);
  }

  for (const fallback of PLACEHOLDER_BULLETS) {
    if (bullets.length >= MIN_BULLETS) break;
    if (!bullets.includes(fallback)) bullets.push(fallback);
  }

  return bullets.slice(0, MAX_BULLETS);
}

// Memoized per account: the fallback is that account's own uploaded cover
// letter, so one cache entry for the whole process would leak one user's
// letter into another user's drafts. Bounded, because "one entry per account
// ever served" is a leak in a process meant to stay up for weeks; an evicted
// entry costs one file read to rebuild.
const TEMPLATE_CACHE_CAPACITY = 256;
const cachedTemplates = new BoundedCache<string, string>(TEMPLATE_CACHE_CAPACITY);

/** Forget the memoized template (call after a cover_letter document upload). */
export function resetCoverLetterTemplateCache(userId?: string): void {
  if (userId === undefined) cachedTemplates.clear();
  else cachedTemplates.delete(userId);
}

/**
 * Resolves the reference cover letter, in order of preference:
 *   1. the text file at `coverLetterTemplatePath` (gitignored by default),
 *   2. the text extracted from the uploaded `cover_letter` PDF document,
 *   3. BUILT_IN_COVER_LETTER_TEMPLATE.
 * Memoized; never throws.
 */
export async function getCoverLetterTemplate(userId: string): Promise<string> {
  const cached = cachedTemplates.get(userId);
  if (cached !== undefined) return cached;

  const templateFile = coverLetterTemplatePath();
  try {
    const text = await fs.promises.readFile(templateFile, "utf8");
    if (text.trim().length > 0) {
      cachedTemplates.set(userId, text.trim());
      return text.trim();
    }
  } catch {
    // No template file - fall through to the uploaded document.
  }

  try {
    const document = await getDocument(userId, "cover_letter");
    if (document) {
      const buffer = await fs.promises.readFile(document.path);
      const text = (await extractPdfTextFromBuffer(buffer)).trim();
      if (text.length > 0) {
        logger.info(
          { templateFile },
          "Cover letter template file not found, using the uploaded cover_letter document instead",
        );
        cachedTemplates.set(userId, text);
        return text;
      }
    }
  } catch (err) {
    logger.warn({ err }, "Could not read the uploaded cover letter document for the template");
  }

  logger.info(
    { templateFile },
    "No cover letter template file or uploaded letter found, using the built-in placeholder",
  );
  cachedTemplates.set(userId, BUILT_IN_COVER_LETTER_TEMPLATE);
  return BUILT_IN_COVER_LETTER_TEMPLATE;
}

export function coverLetterFor(title: string, company: string, template: string): string {
  return `Application: ${title} at ${company}\n\n${template}`;
}
