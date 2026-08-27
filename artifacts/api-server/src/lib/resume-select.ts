// Lot I3 (multi-CV masters): deterministic resume selection for one job
// posting. Pure - no database, no AI, no randomness - so the same resumes
// and the same posting always pick the same winner.
//
// Term extraction reuses lib/anonymous-match.ts's extractCvProfile(), the
// weighted skill-keyword detector the anonymous trial funnel (/try) already
// uses to score a pasted CV against the shared posting pool. Reusing that
// exported function keeps this module small - no second keyword-rule list to
// maintain - without touching anonymous-match.ts, which stays entirely on
// its own path (/try never calls into this module, and this module never
// calls matchAnonymousCv).
//
// RULE D'OR: an account with a single resume always gets that resume back,
// with no scoring at all - see selectResumeForJob below. That is what keeps
// a mono-CV account's tailoring/fit-analysis/interview-brief prompts
// byte-identical to how they read before this lot.

import { extractCvProfile } from "./anonymous-match";

export type SelectableResume = {
  id: number;
  label: string;
  content: string;
  isDefault: boolean;
};

export type ResumeSelectionJob = {
  title: string;
  description: string;
};

/** A skill hit in the posting title counts double a hit in the description - same weighting anonymous-match.ts's own scorer uses. */
const TITLE_WEIGHT = 2;
const DESCRIPTION_WEIGHT = 1;

/** How well `resumeContent` overlaps `job`'s title + description, in the shared skill vocabulary. */
function overlapScore(resumeContent: string, job: ResumeSelectionJob): number {
  const resumeSkills = extractCvProfile(resumeContent).skills;
  if (resumeSkills.size === 0) return 0;

  const titleSkills = extractCvProfile(job.title).skills;
  const descriptionSkills = extractCvProfile(job.description).skills;

  let score = 0;
  for (const skill of resumeSkills) {
    if (titleSkills.has(skill)) score += TITLE_WEIGHT;
    if (descriptionSkills.has(skill)) score += DESCRIPTION_WEIGHT;
  }
  return score;
}

/** The resume marked `isDefault`, or the first one when somehow none is (lib/repo/resumes.ts always keeps exactly one default). */
function defaultResume<T extends SelectableResume>(resumes: readonly T[]): T {
  return resumes.find((resume) => resume.isDefault) ?? resumes[0]!;
}

/**
 * Picks the best-matching resume for `job` out of `resumes`.
 *
 * - Zero or one resume: returned outright, no scoring. This is the common
 *   case (today's single-master-resume accounts) and it is intentionally
 *   the very first check, so nothing about scoring can ever touch it.
 * - Two or more: each resume is scored by weighted skill overlap against the
 *   posting's title + description. The highest score wins.
 * - A tie for the highest score, or every resume scoring zero (no shared
 *   vocabulary at all - e.g. postings/resumes with no recognized skill
 *   keywords), falls back to the default resume rather than guessing.
 *
 * Deterministic and pure: same input, same output, every time.
 */
export function selectResumeForJob<T extends SelectableResume>(
  resumes: readonly T[],
  job: ResumeSelectionJob,
): T {
  if (resumes.length === 0) {
    throw new Error("selectResumeForJob: at least one resume is required");
  }
  if (resumes.length === 1) return resumes[0]!;

  const scored = resumes.map((resume) => ({ resume, score: overlapScore(resume.content, job) }));
  const topScore = Math.max(...scored.map((entry) => entry.score));
  if (topScore === 0) return defaultResume(resumes);

  const winners = scored.filter((entry) => entry.score === topScore);
  if (winners.length > 1) return defaultResume(resumes);

  return winners[0]!.resume;
}
