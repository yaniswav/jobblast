// Interview prep briefs: when an application reaches status "interview", a
// tool-using agent researches the company on the live web and writes a
// preparation dossier (markdown) the user can read in the tracker or export
// as a PDF.
//
// Two halves live here:
//
//   ensureInterviewBrief()   - the queue side. Called from the PATCH
//                              /applications/:id route and from the Gmail
//                              sync pass, the two places a row can reach
//                              "interview". Inserts a "pending" row if there
//                              isn't one already. Deliberately the only way
//                              a brief is ever queued, so both callers stay
//                              one line long and behave identically.
//   runInterviewBriefPass()  - the generation side. Picks up pending rows and
//                              fills them in, one agent call at a time.
//
// Unlike tailor.ts / fit-analysis.ts this needs an AGENT provider with the
// "web" tool, not just a text provider: the whole value of the brief is that
// the company facts in it (recent news, products, stack, culture) come from
// real, current sources rather than from the model's memory. On a provider
// that cannot run tool-using agents (anthropic-api, openai-compatible,
// ollama, lmstudio, or ai.provider "none") the pass logs once and does
// nothing - pending rows simply stay pending.
//
// Runs after gmail-sync in src/index.ts's sequential chain, never in
// parallel with it, so at most one provider call is in flight at a time. The
// batch is small (2 briefs per pass) because each run is a multi-minute web
// research session.

import type { FitAnalysis } from "@workspace/db";
import { getApplicationWithPosting } from "../repo/applications";
import {
  listPendingBriefs,
  queueBrief,
  reclaimStuckBriefs,
  resetBrief,
  updateBrief,
} from "../repo/interview-briefs";
import { getProfile } from "../repo/profile";
import { tryConsumeQuota } from "../repo/usage";
import { logger } from "../logger";
import { quotaCapFor } from "../quota-config";
import { letterLanguageRule } from "./language";
import { configuredProviderName, getAgentProvider, type AgentProvider } from "./provider";
import { sanitizeAiText } from "./sanitize";

/** Briefs generated per pass. Each one is a multi-minute research run. */
const DEFAULT_LIMIT = 2;
/** Same rationale as fit-analysis.ts: cap retries, then park the row. */
const MAX_ATTEMPTS_PER_BRIEF = 3;
/** Real web research across a dozen pages is slow; this is the ceiling. */
const AGENT_TIMEOUT_MS = 12 * 60 * 1000;

const DESCRIPTION_TRUNCATE_CHARS = 4000;
const MIN_QUESTIONS = 8;
const MAX_QUESTIONS = 12;
/** Anything shorter than this is not a dossier, whatever the model claims. */
const MIN_BRIEF_CHARS = 800;
/** A usable brief is sectioned; a single wall of text is a failed run. */
const MIN_H2_SECTIONS = 4;

// ---------------------------------------------------------------------------
// Queue side
// ---------------------------------------------------------------------------

/**
 * Queues a brief for `applicationId` unless one already exists, in any
 * status. Idempotent and never throws: a tracker status change must not fail
 * because the brief queue is unhappy, so problems are logged and swallowed.
 *
 * Returns true when a new row was inserted.
 */
export async function ensureInterviewBrief(
  userId: string,
  applicationId: number,
): Promise<boolean> {
  try {
    const queued = await queueBrief(userId, applicationId);
    if (queued) logger.info({ applicationId }, "Interview brief queued");
    return queued;
  } catch (err) {
    logger.error({ err, applicationId }, "Interview brief: failed to queue");
    return false;
  }
}

// ---------------------------------------------------------------------------
// Prompt
// ---------------------------------------------------------------------------

function truncate(text: string, maxChars: number): string {
  return text.length > maxChars ? `${text.slice(0, maxChars)}...` : text;
}

/** The fit analysis rendered as prompt input, or "" when the job has none. */
function fitAnalysisBlock(fitAnalysis: FitAnalysis | null): string {
  if (!fitAnalysis) return "";
  const lines: string[] = [`Overall verdict: ${fitAnalysis.verdict}`];
  if (fitAnalysis.redFlags.length > 0) {
    lines.push(`Concerns already identified: ${fitAnalysis.redFlags.join(" | ")}`);
  }
  if (fitAnalysis.gaps.length > 0) {
    lines.push(`Gaps between the resume and the posting: ${fitAnalysis.gaps.join(" | ")}`);
  }
  if (fitAnalysis.greenFlags.length > 0) {
    lines.push(`Strengths already identified: ${fitAnalysis.greenFlags.join(" | ")}`);
  }
  return `\nEARLIER FIT ANALYSIS OF THIS POSTING (produced by this app, from the resume and the posting):\n"""\n${lines.join("\n")}\n"""\n`;
}

export function buildInterviewBriefPrompt(params: {
  masterResume: string;
  headline: string;
  title: string;
  company: string;
  location: string;
  description: string;
  fitAnalysis: FitAnalysis | null;
}): string {
  const { masterResume, headline, title, company, location, description, fitAnalysis } = params;
  const { letterLanguageNames, fallbackLanguageName } = letterLanguageRule();

  const headlineBlock = headline.trim() ? `CANDIDATE HEADLINE: ${headline.trim()}\n\n` : "";
  const fitBlock = fitAnalysisBlock(fitAnalysis);
  const defenceSection = fitAnalysis
    ? `\n## Where you are weak, and what to say
Take the concerns and gaps from the fit analysis above, one at a time. For each, write the honest, non-defensive answer this candidate can actually give: what is true, what compensates for it in the resume, and what they are doing about it. Never suggest claiming experience they do not have.`
    : "";

  return `You are preparing a candidate for a real job interview that has already been scheduled. Your job is to research the employer on the live web and write them a preparation dossier they will read the night before.

${headlineBlock}CANDIDATE'S RESUME (their real, full background - the ONLY source of facts about them you may use):
"""
${masterResume}
"""

THE ROLE THEY ARE INTERVIEWING FOR:
Title: ${title}
Company: ${company}
Location: ${location}
Posting:
"""
${truncate(description, DESCRIPTION_TRUNCATE_CHARS)}
"""
${fitBlock}
RESEARCH - MANDATORY, DO THIS FIRST
Use WebSearch and WebFetch (actually call them, do not work from memory) to find out about ${company} as it is TODAY. Search the company's own site and careers page, its engineering or product blog, recent press coverage, and employee reviews. Look specifically for:
- what the company actually builds and sells, and who its customers are
- news from the last 12 months: funding, launches, layoffs, acquisitions, leadership changes, strategy shifts
- the engineering stack and tooling they talk about publicly
- how they describe their culture and how their interview process is described by candidates
If a search returns nothing useful about a point, say so plainly in the brief instead of filling the gap with a guess.

WRITE THE DOSSIER as markdown with exactly these "## " sections, in this order. The section names below are given in English for structure only: TRANSLATE each heading into the dossier language decided by the LANGUAGE rule (a French dossier gets French headings, etc.):

## The company in five minutes
What they build, who pays them, how big they are, where this role sits. Then the last 12 months: the news that a candidate would look uninformed for not knowing.

## Their stack and how they work
The technologies, tools and engineering practices this employer actually uses, from your research and from the posting. Call out explicitly which of them appear in the candidate's resume.

## What the process will look like
The interview format a company of this type, size and country typically runs for this kind of role, plus anything specific you found about THIS company's process. Say which parts you found evidence for and which are the general pattern.

## Questions they are likely to ask
${MIN_QUESTIONS} to ${MAX_QUESTIONS} questions, as a numbered list. Mix them: technical questions on the stack this posting names, behavioural questions, and questions specific to this company and its situation. After each question, on its own line starting with "Angle:", give a one or two line suggested answer angle that points at something REAL in the resume above.

## Your 60 seconds
A "tell me about yourself" pitch, written in the first person, ready to say out loud in about 60 seconds. It must be built only from the resume, and it must land on why this candidate and THIS company fit.
${defenceSection}

## Questions to ask them
4 to 6 questions the candidate should ask, each one showing they did the research you just did. Not "what is the culture like" - questions that could only be asked by someone who read this company's news and this posting.

RULES, all mandatory:
- NEVER invent anything about the candidate. Every claim about their experience must be traceable to the resume above. If the posting asks for something they lack, say so.
- Every company fact must come from your research. Cite the kind of source inline in parentheses, like "(source: company blog)", "(source: TechCrunch)", "(source: Glassdoor reviews)". If you could not verify something, write that you could not verify it.
- Do not invent news, funding rounds, customers or headcount. An honest "I could not find recent news about this company" is a correct and acceptable answer.

STYLE:
- Markdown only: "## " for the sections above, "- " for bullets, numbered lists where asked. No "# " title, no tables, no code fences.
- No em dashes or en dashes (use commas or parentheses), straight quotes only.
- Write to the candidate, directly and concretely. No filler, no motivational padding.

LANGUAGE: the candidate can interview in ${letterLanguageNames}. If the job posting above is written in one of those languages, write the ENTIRE dossier in that language. Otherwise write it in ${fallbackLanguageName}. ONE language for the whole document: every section heading, every question and every answer angle must be in that same language, with no mixing (translate any English interview jargon). Never write in a language the candidate has not listed.

Output the markdown dossier only. No preamble, no commentary, no code fences around it.`;
}

// ---------------------------------------------------------------------------
// Output cleanup + validation
// ---------------------------------------------------------------------------

/**
 * Turns the agent's raw stdout into the markdown we store: unwraps a code
 * fence if it wrapped the whole answer, drops any chatter before the first
 * "## " heading, and normalizes the AI typography (see lib/ai/sanitize.ts).
 * Exported for testability.
 */
export function cleanBriefMarkdown(raw: string): string {
  let text = raw.trim();

  // A whole-answer code fence, despite being told not to.
  const fenced = /^```(?:markdown|md)?\s*\n([\s\S]*?)\n```$/.exec(text);
  if (fenced?.[1]) text = fenced[1].trim();

  // Preamble before the first section ("Here is the dossier:"). Only dropped
  // when a "## " heading actually exists, so a malformed answer still fails
  // validation below rather than being silently emptied.
  if (!text.startsWith("#")) {
    const index = text.search(/^## /m);
    if (index > 0) text = text.slice(index);
  }

  return sanitizeAiText(text);
}

/** True when `markdown` looks like an actual sectioned dossier. */
export function isValidBriefMarkdown(markdown: string): boolean {
  if (markdown.length < MIN_BRIEF_CHARS) return false;
  const sections = markdown.match(/^## .+$/gm) ?? [];
  return sections.length >= MIN_H2_SECTIONS;
}

// ---------------------------------------------------------------------------
// Generation
// ---------------------------------------------------------------------------

type BriefContext = {
  masterResume: string;
  headline: string;
};

/** Everything one brief needs, or null when the row is unusable. */
async function loadBriefInput(userId: string, applicationId: number) {
  return getApplicationWithPosting(userId, applicationId);
}

async function generateBrief(
  input: NonNullable<Awaited<ReturnType<typeof loadBriefInput>>>,
  context: BriefContext,
  provider: AgentProvider,
): Promise<string | null> {
  const { application, posting: job, fitAnalysis } = input;

  const prompt = buildInterviewBriefPrompt({
    masterResume: context.masterResume,
    headline: context.headline,
    // The application row carries the title/company/location as they were
    // when the user approved it; the job listing carries the description.
    title: application.title || job.title,
    company: application.company || job.company,
    location: application.location || job.location,
    description: job.description,
    fitAnalysis,
  });

  const rawResult = await provider.runAgent(prompt, {
    timeoutMs: AGENT_TIMEOUT_MS,
    tools: ["web"],
    // The brief is read once, the night before an interview that took weeks
    // to get. Latency is irrelevant next to being right.
    effort: "high",
  });

  const markdown = cleanBriefMarkdown(rawResult);
  if (!isValidBriefMarkdown(markdown)) {
    logger.warn(
      { applicationId: application.id, chars: markdown.length, preview: markdown.slice(0, 300) },
      "Interview brief: model output did not look like a dossier",
    );
    return null;
  }
  return markdown;
}

// ---------------------------------------------------------------------------
// The pass
// ---------------------------------------------------------------------------

/** Accounts with a pass in flight: one per account, never one per process. */
const passRunningFor = new Set<string>();
/** applicationId -> failed attempts this process. See MAX_ATTEMPTS_PER_BRIEF. */
const attemptsByApplication = new Map<number, number>();
const noAgentNoticeLoggedFor = new Set<string>();

/** The agent provider if it can search the web, else null (logged once per account). */
async function briefAgent(userId: string): Promise<AgentProvider | null> {
  const provider = await getAgentProvider(userId);
  if (provider?.supportsTool("web")) return provider;

  if (!noAgentNoticeLoggedFor.has(userId)) {
    noAgentNoticeLoggedFor.add(userId);
    logger.info(
      `Interview briefs disabled: provider "${configuredProviderName()}" cannot run web-searching agents (use claude-cli, codex-cli or gemini-cli)`,
    );
  }
  return null;
}

/**
 * Records a failed attempt: back to "pending" so the next pass retries, or
 * parked as "failed" with the reason once the cap is reached. Only an
 * explicit regenerate brings a "failed" row back.
 */
async function recordFailure(
  userId: string,
  applicationId: number,
  message: string,
): Promise<void> {
  const attempts = (attemptsByApplication.get(applicationId) ?? 0) + 1;
  attemptsByApplication.set(applicationId, attempts);

  const exhausted = attempts >= MAX_ATTEMPTS_PER_BRIEF;
  await updateBrief(userId, applicationId, {
    status: exhausted ? "failed" : "pending",
    error: message.slice(0, 2000),
  });

  logger.warn(
    { applicationId, attempts, exhausted },
    exhausted ? "Interview brief: retry cap reached, marking failed" : "Interview brief: attempt failed, will retry",
  );
}

/**
 * Generates up to `limit` pending briefs, oldest first, one agent call at a
 * time. No-ops (via a module-level guard) if a pass is already running, and
 * when the configured provider cannot run web-searching agents.
 *
 * Never throws: every failure is recorded on the row and logged, same
 * contract as the other periodic passes.
 */
export async function runInterviewBriefPass(
  userId: string,
  limit: number = DEFAULT_LIMIT,
): Promise<void> {
  if (passRunningFor.has(userId)) {
    logger.debug("Interview brief pass already running, skipping this trigger");
    return;
  }

  const provider = await briefAgent(userId);
  if (!provider) return;

  passRunningFor.add(userId);

  try {
    // Crash recovery: the module guard above means no other pass is holding a
    // row right now, so anything still "generating" belongs to a process that
    // died mid-run and would otherwise be stuck forever.
    const reclaimed = await reclaimStuckBriefs(userId);
    if (reclaimed > 0) {
      logger.warn({ count: reclaimed }, "Interview brief: reclaimed rows left mid-generation by a previous run");
    }

    const pending = await listPendingBriefs(userId, limit);

    const eligible = pending.filter(
      (applicationId) => (attemptsByApplication.get(applicationId) ?? 0) < MAX_ATTEMPTS_PER_BRIEF,
    );
    if (eligible.length === 0) {
      logger.debug("Interview brief pass: nothing pending");
      return;
    }

    const profile = await getProfile(userId);
    if (!profile) {
      logger.warn("Interview brief pass: no profile row found, skipping");
      return;
    }
    const context: BriefContext = { masterResume: profile.masterResume, headline: profile.headline };

    logger.info({ count: eligible.length, provider: provider.name }, "Interview brief pass starting");

    let succeeded = 0;
    let failed = 0;
    const cap = quotaCapFor("brief");

    for (const applicationId of eligible) {
      // Checked before the provider call, never after (docs/SAAS-ARCHITECTURE.md
      // section 5). Exceeding the daily cap is not an error: the remaining
      // briefs simply stay pending and are picked up by tomorrow's pass.
      const quota = await tryConsumeQuota(userId, "brief", cap);
      if (!quota.allowed) {
        logger.info({ used: quota.used, cap: quota.cap }, "Interview brief pass: daily quota reached, deferring the rest to tomorrow");
        break;
      }

      const startedAt = Date.now();
      try {
        const input = await loadBriefInput(userId, applicationId);
        if (!input) {
          // The application (or its job) is gone. Nothing will ever fix this
          // row, so park it rather than retrying every 30 minutes.
          await updateBrief(userId, applicationId, {
            status: "failed",
            error: "The application this brief belongs to no longer exists",
          });
          failed++;
          continue;
        }

        await updateBrief(userId, applicationId, { status: "generating", error: null });

        const markdown = await generateBrief(input, context, provider);
        const ms = Date.now() - startedAt;

        if (!markdown) {
          failed++;
          await recordFailure(userId, applicationId, "The AI returned something that was not a usable brief");
          logger.warn({ applicationId, ms, ok: false }, "Interview brief: invalid output");
          continue;
        }

        await updateBrief(userId, applicationId, {
          status: "ready",
          contentMarkdown: markdown,
          generatedAt: new Date(),
          error: null,
        });

        succeeded++;
        attemptsByApplication.delete(applicationId);
        logger.info({ applicationId, ms, ok: true, chars: markdown.length }, "Interview brief generated");
      } catch (err) {
        failed++;
        const ms = Date.now() - startedAt;
        const message = err instanceof Error ? err.message : String(err);
        logger.error({ applicationId, ms, ok: false, err }, "Interview brief: generation failed");
        await recordFailure(userId, applicationId, message).catch((updateErr: unknown) => {
          logger.error({ err: updateErr, applicationId }, "Interview brief: could not record the failure");
        });
      }
    }

    logger.info({ succeeded, failed, total: eligible.length }, "Interview brief pass complete");
  } catch (err) {
    logger.error({ err }, "Interview brief pass failed");
  } finally {
    passRunningFor.delete(userId);
  }
}

/**
 * Resets a brief back to "pending", clearing whatever was there. Used by the
 * regenerate endpoint; also clears the in-process retry counter so a row the
 * user explicitly asked to retry gets a full budget of attempts again.
 *
 * Returns false when the application has no brief row at all.
 */
export async function resetInterviewBrief(
  userId: string,
  applicationId: number,
): Promise<boolean> {
  const reset = await resetBrief(userId, applicationId);
  if (!reset) return false;
  attemptsByApplication.delete(applicationId);
  logger.info({ applicationId }, "Interview brief reset to pending");
  return true;
}
