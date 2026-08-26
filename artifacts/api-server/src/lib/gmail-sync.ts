// Gmail sync: keeps the application tracker up to date from the recruiter
// mail the user actually receives, instead of asking them to remember to
// change a dropdown after every reply.
//
// One cycle is three passes, and the split between them is the whole design:
//
//   1. READ PASS (AI, lib/ai/provider.ts with the "gmail" capability) - a
//      strictly read-only agent run that searches the last N days of mail and
//      returns a JSON array of application-related e-mails. The model's only
//      job is reading mail and describing it. It never sees the database,
//      never learns which companies the user applied to, and cannot act.
//   2. MATCHING (pure TypeScript, below) - deterministic, no AI. Decides
//      which `applications` row (if any) each e-mail belongs to.
//   3. APPLY + JOURNAL - performs the small set of allowed status moves and
//      appends a note, or records why it declined to.
//
// Why the model is kept out of step 2: this is the only feature in JobBlast
// that mutates the tracker on its own, and a wrong move is destructive in a
// way the user may not notice for weeks (an "interview" quietly turned into
// "rejected" is a job they stop chasing). A model asked to match "Thales
// Group" against a list of applications will happily also match "Thales
// Alenia Space" and explain why that was reasonable. A string comparison
// will not. So the AI's output is treated as untrusted input describing the
// outside world, and every decision that touches a row is made by code whose
// rules are written out below and can be reasoned about without running it.
//
// The safety rules, in one place:
//   - Only rows in status "applied" or "responded" are ever candidates.
//     "approved" (prepared but not actually sent by the user - see the
//     comment in lib/db/src/schema/applications.ts), "interview",
//     "rejected" and "offer" are never touched by this pass.
//   - Only three transitions exist: applied -> responded, applied/responded
//     -> interview, applied/responded -> rejected. Nothing moves backwards,
//     and "offer" is never set automatically, by any path, ever - an offer
//     is the user's news to enter themselves.
//   - `notes` is only ever appended to, never overwritten or cleared.
//   - Ambiguity always loses: two applications matching one e-mail, a
//     company name too short to compare, a rejection at a company with
//     several open applications and no clear role - all of these are
//     journaled and skipped rather than guessed at.
//   - `gmailSync.dryRun` runs everything including the matching and writes
//     nothing, so the journal can be read before any row is touched.
//
// Every decision, acted on or skipped, is appended to
// data/gmail-sync-journal.jsonl (gitignored with the rest of data/). That
// file is the audit trail - "why did this application become 'rejected'?"
// is answerable months later - and it is also how the pass avoids acting on
// the same e-mail twice: the mailbox search looks back 2 days while the pass
// runs every 3 hours, so the same message is seen a dozen times or more, and
// only the first sighting is allowed to do anything.
//
// Throttled to at most once per 3h via a timestamp file, same mechanism as
// lib/sources/notion-inbox.ts and aiscout.ts.

import fs from "node:fs";
import path from "node:path";
import { ensureInterviewBrief } from "./ai/interview-brief";
import { configuredProviderName, getAgentProvider, type AgentProvider } from "./ai/provider";
import { loadConfig } from "./config";
import { logger } from "./logger";
import { listApplications, updateApplication } from "./repo/applications";
import { parseJsonArrayResponse } from "./sources/cli-json";
import { REPO_ROOT } from "./storage";

const STATE_FILE = path.join(REPO_ROOT, "data", "gmail-sync-last-run.txt");
const JOURNAL_FILE = path.join(REPO_ROOT, "data", "gmail-sync-journal.jsonl");

const MIN_INTERVAL_MS = 3 * 60 * 60 * 1000; // 3h
const CLI_TIMEOUT_MS = 4 * 60 * 1000; // 4 minutes - a mailbox search + a few thread reads

const MAX_EXCERPT_CHARS = 200;
/** Beyond this, a batch of "matches" is more likely a bad read pass than a busy week. */
const MAX_EMAILS_PER_RUN = 40;

// ---------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------

export const GMAIL_EMAIL_KINDS = ["confirmation", "reply", "interview", "rejection"] as const;
export type GmailEmailKind = (typeof GMAIL_EMAIL_KINDS)[number];

/** One application-related e-mail, as reported by the read pass. */
export type GmailEmail = {
  /** The hiring company, as the model read it off the message. */
  company: string;
  /** The role the message refers to, or "" when it names none. */
  jobTitleGuess: string;
  kind: GmailEmailKind;
  /** YYYY-MM-DD, as received. */
  date: string;
  from: string;
  /** <= MAX_EXCERPT_CHARS characters copied from the message. */
  excerpt: string;
};

/** The subset of an `applications` row this pass reasons about. */
export type TrackedApplication = {
  id: number;
  title: string;
  company: string;
  status: string;
  notes: string;
};

/** Statuses a row must be in to be a candidate at all. */
const ELIGIBLE_STATUSES: readonly string[] = ["applied", "responded"];

/** What each kind of e-mail means for the row's status. null = note only. */
const TARGET_STATUS_BY_KIND = {
  // An ATS acknowledgement only proves the application arrived, which the
  // user already told us when they marked it "applied". It earns a note, not
  // a status move.
  confirmation: null,
  reply: "responded",
  interview: "interview",
  rejection: "rejected",
} satisfies Record<GmailEmailKind, string | null>;

/**
 * The complete set of moves this pass may make. Anything not listed here -
 * including every move out of "approved", "interview", "rejected" and
 * "offer", every move backwards, and any move *to* "offer" - is impossible
 * by construction rather than by an `if` somewhere.
 */
// Looked up by application.status (a plain string) below, so the `string`
// index signature is load-bearing.
// eslint-disable-next-line anti-slop/no-known-value-widening
const ALLOWED_TRANSITIONS: Record<string, readonly string[]> = {
  applied: ["responded", "interview", "rejected"],
  responded: ["interview", "rejected"],
};

const NOTE_LABEL_BY_KIND = {
  confirmation: "Application confirmation",
  reply: "Recruiter reply",
  interview: "Interview invitation",
  rejection: "Rejection",
} satisfies Record<GmailEmailKind, string>;

// ---------------------------------------------------------------------------
// Provider gate
// ---------------------------------------------------------------------------

/** So an unsupported provider doesn't print the same line every cycle. */
let disabledNoticeLogged = false;

/**
 * The agent provider if it can read Gmail *without* also being able to write
 * to it, else null (logged once). Only claude-cli qualifies today: its
 * --allowedTools is a real per-run allowlist, so the read-only promise is
 * enforced by the CLI rather than by the prompt. See the "gmail" entry in
 * lib/ai/provider.ts.
 */
async function gmailAgent(userId: string): Promise<AgentProvider | null> {
  const provider = await getAgentProvider(userId);
  if (provider?.supportsTool("gmail")) return provider;

  if (!disabledNoticeLogged) {
    disabledNoticeLogged = true;
    logger.info(
      `Gmail sync disabled: provider "${configuredProviderName()}" cannot run a read-only Gmail agent (use claude-cli with the claude.ai Gmail connector authorized)`,
    );
  }
  return null;
}

// ---------------------------------------------------------------------------
// Throttle
// ---------------------------------------------------------------------------

/**
 * True if the last attempt (successful or not) was under MIN_INTERVAL_MS
 * ago. Same rationale as notion-inbox.ts: a timestamp file rather than a
 * query, because a run that finds nothing would otherwise never throttle.
 */
function shouldSkipDueToFrequency(): boolean {
  let raw: string;
  try {
    raw = fs.readFileSync(STATE_FILE, "utf8");
  } catch {
    return false; // never run before
  }

  const lastRunMs = Date.parse(raw.trim());
  if (Number.isNaN(lastRunMs)) return false;

  return Date.now() - lastRunMs < MIN_INTERVAL_MS;
}

function markRan(): void {
  try {
    fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
    fs.writeFileSync(STATE_FILE, new Date().toISOString(), "utf8");
  } catch (err) {
    logger.warn({ err }, "Gmail sync: failed to write last-run timestamp file");
  }
}

// ---------------------------------------------------------------------------
// 1. Read pass
// ---------------------------------------------------------------------------

export function buildReadPrompt(lookbackDays: number): string {
  return `You have READ-ONLY access to the user's Gmail through MCP tools whose names start with "mcp__claude_ai_Gmail" (search_threads, get_thread, get_message, list_labels). Actually call them - do not just describe what you would do.

READ-ONLY - ABSOLUTE RULES. During this task you must NEVER, for any reason:
- send a message, reply to one, or forward one
- create, update or delete a draft
- create, apply, remove, update or delete any label, including read/unread and starred state
- trash, untrash or permanently delete any message or thread
- mark anything as spam or as not spam
- change anything whatsoever in the mailbox
You may only search and read. If something looks like it needs a reply or a label, do not touch it - just report it. Only the four read tools above are available to you; do not try to work around that.

TASK
Find the e-mails received in the last ${lookbackDays} day(s) that concern a job application THIS USER HAS ALREADY SENT. Start with search_threads using a query that includes "newer_than:${lookbackDays}d", then open the promising threads with get_thread / get_message and read enough of the body to classify each one correctly. Run several searches if one is not enough.

The mailbox may be in French or in English. Search terms worth trying: candidature, "votre candidature", "suite a votre candidature", application, "your application", "we received your application", entretien, interview, "phone screen", recrutement, recruitment, "nous avons le regret", "we regret", "unfortunately", "not moving forward". Automated senders from applicant tracking systems are often the most useful hits: greenhouse.io, lever.co, myworkday, smartrecruiters, teamtailor, welcometothejungle, recruitee, ashbyhq, workable, taleo, successfactors.

CLASSIFY each e-mail you keep as exactly one "kind":
- "confirmation" - an automated acknowledgement that an application was received
- "reply" - a human recruiter writing about the application (a question, a request for documents, a status update, next steps) that is neither an interview invitation nor a rejection
- "interview" - an invitation to an interview, a phone screen, a technical test or an assessment, or a request to schedule one
- "rejection" - the application was declined, or the position was filled, cancelled or closed

EXCLUDE, and do not return at all: job alerts and job-board digests, newsletters and marketing, LinkedIn / Indeed "jobs picked for you" e-mails, messages the user sent themselves, recruiter cold outreach about a role the user never applied to, interview reminders for something already handled, and anything unrelated to a job application.

FIELDS, for each e-mail you keep:
- "company": the HIRING company, never the applicant tracking system. If the message comes from an ATS address (no-reply@greenhouse.io, no-reply@lever.co, ...), take the employer's name out of the subject line or the body. Never report the vendor's name as the company.
- "jobTitleGuess": the job title the message refers to, written as it appears in the message. Use "" if the message names no role - do not infer one.
- "kind": one of "confirmation", "reply", "interview", "rejection".
- "date": the date the message was received, as "YYYY-MM-DD".
- "from": the sender, as "Name <address>" or just the address.
- "excerpt": at most ${MAX_EXCERPT_CHARS} characters copied verbatim from the message, showing what it is about. One line, no newlines. Never write your own summary here.

Return STRICT JSON: an array of objects shaped exactly like this:
{"company": "...", "jobTitleGuess": "...", "kind": "interview", "date": "2026-01-31", "from": "...", "excerpt": "..."}

Rules, all mandatory:
- If no e-mail matches, return an empty array [].
- Never invent a company name, a date or an excerpt. If you cannot tell which company an e-mail is about after reading it, leave that e-mail out entirely.
- One object per e-mail. If a thread contains several relevant messages, report the most recent one only.
- Do not include any field other than the six listed above.

Output ONLY the raw JSON array, no markdown code fences, no commentary before or after it.`;
}

/** Collapses whitespace and caps length, so a note line stays one line. */
function tidy(value: string, maxChars: number): string {
  const oneLine = value.replace(/\s+/g, " ").trim();
  return oneLine.length > maxChars ? `${oneLine.slice(0, maxChars - 1).trimEnd()}…` : oneLine;
}

/** Exported for testability: validates + normalizes one row of the read pass. */
export function toGmailEmail(value: unknown): GmailEmail | null {
  if (typeof value !== "object" || value === null) return null;
  const candidate = value as Record<string, unknown>;

  const company = candidate["company"];
  const kind = candidate["kind"];
  if (typeof company !== "string" || company.trim().length === 0) return null;
  if (typeof kind !== "string" || !(GMAIL_EMAIL_KINDS as readonly string[]).includes(kind)) return null;

  const asString = (key: string): string => (typeof candidate[key] === "string" ? (candidate[key] as string) : "");

  return {
    company: tidy(company, 200),
    jobTitleGuess: tidy(asString("jobTitleGuess"), 200),
    kind: kind as GmailEmailKind,
    date: tidy(asString("date"), 32),
    from: tidy(asString("from"), 200),
    excerpt: tidy(asString("excerpt"), MAX_EXCERPT_CHARS),
  };
}

/**
 * Runs the read-only mailbox pass. Never throws - returns [] on any failure,
 * logging why, exactly like the source fetchers.
 */
export async function readApplicationEmails(provider: AgentProvider, lookbackDays: number): Promise<GmailEmail[]> {
  let rawResult: string;
  const startedAt = Date.now();
  try {
    rawResult = await provider.runAgent(buildReadPrompt(lookbackDays), {
      timeoutMs: CLI_TIMEOUT_MS,
      tools: ["gmail"],
    });
  } catch (err) {
    logger.error({ err, provider: provider.name, ms: Date.now() - startedAt }, "Gmail sync: read-pass agent call failed");
    return [];
  }
  logger.info({ provider: provider.name, ms: Date.now() - startedAt }, "Gmail sync: read-pass agent call completed");

  const parsed = parseJsonArrayResponse(rawResult);
  if (!parsed) {
    logger.warn(
      { rawResultPreview: rawResult.slice(0, 500) },
      "Gmail sync: model output was not (or did not contain) a valid JSON array",
    );
    return [];
  }

  const emails = parsed.map(toGmailEmail).filter((email): email is GmailEmail => email !== null);
  const invalidCount = parsed.length - emails.length;
  if (invalidCount > 0) {
    logger.warn({ invalidCount, total: parsed.length }, "Gmail sync: dropped malformed e-mail rows");
  }

  if (emails.length > MAX_EMAILS_PER_RUN) {
    logger.warn(
      { returned: emails.length, cap: MAX_EMAILS_PER_RUN },
      "Gmail sync: read pass returned an implausible number of e-mails, truncating",
    );
    return emails.slice(0, MAX_EMAILS_PER_RUN);
  }
  return emails;
}

// ---------------------------------------------------------------------------
// 2. Matching - deterministic, no AI
//
// The comparison has to survive the ways the same employer is written in a
// job posting versus in the signature of the e-mail its recruiter sends:
// "THALES" / "Thales Group", "Qonto" / "Qonto SAS", "Lemon.io" / "Lemon io",
// "Doctolib" / "doctolib.". So both sides are reduced to a canonical form
// first, and only then compared - by equality, or by one being a whole-word
// run inside the other.
// ---------------------------------------------------------------------------

/**
 * Legal-form suffixes, stripped from the end of a company name.
 *
 * Kept to actual legal forms on purpose. It is tempting to also strip
 * "group", "technologies", "solutions", "consulting" - and that is exactly
 * how "Alpha Solutions" and "Alpha Consulting" become the same company.
 * Descriptive words stay.
 */
const LEGAL_SUFFIXES = new Set([
  // France
  "sas", "sasu", "sarl", "eurl", "sa", "sca", "scs", "snc", "sci", "gie", "cie",
  // Germany / Austria / Switzerland
  "gmbh", "mbh", "ag", "kg", "kgaa", "ohg", "ug", "se",
  // UK / Ireland
  "ltd", "limited", "plc", "llp", "cic",
  // US
  "inc", "incorporated", "llc", "lp", "corp", "corporation", "co",
  // Benelux / Nordics
  "bv", "nv", "cv", "oy", "oyj", "ab", "asa", "aps", "as", "kb", "hb",
  // Southern Europe
  "spa", "srl", "srls", "sl", "slu", "sp", "lda", "sa",
  // Asia-Pacific
  "pte", "pty", "sdn", "bhd", "kk", "yk",
]);

/**
 * Reduces a company name to a comparable form: accents folded, lowercased,
 * punctuation (including "&", "." and "-") turned into spaces, whitespace
 * collapsed, trailing legal forms removed.
 *
 * Non-Latin scripts are preserved rather than deleted - a Taiwanese or
 * Japanese employer name has to survive this too, so the punctuation strip
 * keeps every Unicode letter and digit instead of just [a-z0-9].
 *
 * Exported for testability.
 */
export function normalizeCompany(raw: string): string {
  const tokens = raw
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "") // combining accents left by NFD
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .split(" ")
    .filter((token) => token.length > 0);

  // Repeated, so "Foo GmbH & Co. KG" loses both "kg" and "co". Never empties
  // the name: a company literally called "SA" keeps its one token.
  while (tokens.length > 1 && LEGAL_SUFFIXES.has(tokens[tokens.length - 1]!)) {
    tokens.pop();
  }

  return tokens.join(" ");
}

/**
 * Below this many characters a normalized name carries too little signal to
 * risk a containment match ("SNC", "IBM" style acronyms are exactly where a
 * substring match goes wrong), so only exact equality can match.
 */
const MIN_CONTAINMENT_LENGTH = 4;
/** Shorter than this and the name is not usable for matching at all. */
const MIN_COMPARABLE_LENGTH = 3;

/** True if `needle`'s tokens appear as a contiguous run inside `haystack`'s. */
function containsTokenRun(haystack: string[], needle: string[]): boolean {
  if (needle.length === 0 || needle.length > haystack.length) return false;
  for (let start = 0; start + needle.length <= haystack.length; start++) {
    let matched = true;
    for (let offset = 0; offset < needle.length; offset++) {
      if (haystack[start + offset] !== needle[offset]) {
        matched = false;
        break;
      }
    }
    if (matched) return true;
  }
  return false;
}

/**
 * The confidence bar for "these two names are the same employer":
 *
 *   - both names normalize to at least MIN_COMPARABLE_LENGTH characters, and
 *   - they are exactly equal, or one is a whole-token run inside the other
 *     with the shorter of the two at least MIN_CONTAINMENT_LENGTH long.
 *
 * Containment is checked on whole tokens rather than raw substrings, which
 * costs nothing and rules out the entire class of "Orange" matching
 * "Orangerie" or "SAP" matching "Sapient". "Thales" still matches "Thales
 * Group", as it should.
 *
 * Note what this function is NOT asked to do: it is a same-employer test,
 * not a same-application test. "Thales" genuinely does match both a "Thales"
 * and a "Thales Alenia Space" row, and that is fine, because matching two
 * rows is what evaluateEmail treats as ambiguous and refuses to act on. The
 * looseness is contained by the caller rather than papered over here.
 *
 * Exported for testability.
 */
export function companyMatches(emailCompany: string, applicationCompany: string): boolean {
  const left = normalizeCompany(emailCompany);
  const right = normalizeCompany(applicationCompany);

  if (left.length < MIN_COMPARABLE_LENGTH || right.length < MIN_COMPARABLE_LENGTH) return false;
  if (left === right) return true;

  const shorterLength = Math.min(left.length, right.length);
  if (shorterLength < MIN_CONTAINMENT_LENGTH) return false;

  const leftTokens = left.split(" ");
  const rightTokens = right.split(" ");
  return containsTokenRun(leftTokens, rightTokens) || containsTokenRun(rightTokens, leftTokens);
}

/**
 * Words carrying no information about *which* role a title refers to:
 * gender markers French postings append ("(H/F)", "M/W/D"), articles and
 * prepositions. Seniority and contract words ("senior", "stage",
 * "alternance") are deliberately NOT here - they are often the only thing
 * telling two applications at the same company apart.
 */
const TITLE_STOPWORDS = new Set([
  "h", "f", "m", "w", "d", "x", "hf", "mfd", "mwd",
  "the", "a", "an", "of", "for", "in", "at", "and", "or", "to",
  "le", "la", "les", "un", "une", "de", "du", "des", "et", "en", "chez", "poste",
]);

function significantTitleTokens(title: string): string[] {
  return normalizeCompany(title) // same folding; legal suffixes never appear in titles
    .split(" ")
    .filter((token) => token.length > 1 && !TITLE_STOPWORDS.has(token));
}

/**
 * Words that appear in half of all engineering job titles and therefore say
 * nothing about *which* role a message is about. Sharing only these is not
 * evidence of anything.
 *
 * This list is not cosmetic - it was added because of a real mailbox.
 * "Ingenieur Developpement Logiciels Embarques F/H" and "Ingenieur etude et
 * developpement C/C++ (H/F)" are two genuinely different jobs at one
 * employer, and they share "ingenieur" and "developpement". Any rule that
 * counts raw shared words calls them the same role.
 */
const GENERIC_ROLE_WORDS = new Set([
  "ingenieur", "ingenieure", "engineer", "engineering",
  "developpement", "development", "developpeur", "developer", "dev",
  "software", "logiciel", "logiciels", "informatique",
  "technique", "technical", "consultant", "conseil",
  "analyste", "analyst", "specialist", "specialiste",
  "manager", "responsable", "charge", "chargee",
]);

/**
 * "Could this title and this application be the same role?" Used only by the
 * rejection guard, so it is tuned to be hard to satisfy by accident: a
 * false "yes" here can close an application nobody rejected, while a false
 * "no" only means the user updates a status by hand.
 *
 * Two titles match when they share at least one word that actually
 * identifies the role (see GENERIC_ROLE_WORDS), and either share two words
 * or the guess's words are all present in the title. So "DevOps" matches
 * "Senior DevOps Engineer" (shares the distinctive "devops"), while
 * "Order Engineer" does not match "Ingenieur etude et developpement C/C++"
 * (shares nothing) and neither does "Ingenieur Developpement Logiciels
 * Embarques" (shares only generic words).
 *
 * Exported for testability.
 */
export function titleLikelyMatches(jobTitleGuess: string, applicationTitle: string): boolean {
  const guessTokens = significantTitleTokens(jobTitleGuess);
  const titleTokens = new Set(significantTitleTokens(applicationTitle));
  if (guessTokens.length === 0 || titleTokens.size === 0) return false;

  const shared = guessTokens.filter((token) => titleTokens.has(token));
  if (shared.length === 0) return false;
  if (!shared.some((token) => !GENERIC_ROLE_WORDS.has(token))) return false;

  return shared.length >= 2 || shared.length === guessTokens.length;
}

/** Why a decision went the way it did. Recorded verbatim in the journal. */
export type SkipReason =
  | "company-name-not-comparable"
  | "no-matching-application"
  | "no-eligible-application"
  | "ambiguous-multiple-applications"
  | "status-already-set"
  | "transition-not-allowed"
  | "rejection-role-ambiguous"
  | "rejection-role-mismatch"
  | "already-processed"
  | "already-noted";

export type Evaluation =
  | { outcome: "match"; application: TrackedApplication; targetStatus: string | null }
  | { outcome: "skip"; reason: SkipReason; application?: TrackedApplication };

/**
 * The whole decision, as a pure function of one e-mail and the current
 * tracker contents. No I/O, no AI, no clock. This is the function to read
 * (and the one to test) when asking "could this pass have done X?".
 *
 * Order matters: each rule below is a reason to stop, and the earlier ones
 * are the ones that make the later ones safe to state simply.
 */
export function evaluateEmail(email: GmailEmail, applications: readonly TrackedApplication[]): Evaluation {
  // (a) A name we cannot compare is never matched against anything. Without
  //     this, a two-character company would containment-match half the table.
  if (normalizeCompany(email.company).length < MIN_COMPARABLE_LENGTH) {
    return { outcome: "skip", reason: "company-name-not-comparable" };
  }

  // (b) Every row at this company, in any status. Needed both to tell "no
  //     such company" from "that company, but nothing actionable", and for
  //     the rejection guard in (f).
  const sameCompany = applications.filter((application) => companyMatches(email.company, application.company));
  if (sameCompany.length === 0) {
    return { outcome: "skip", reason: "no-matching-application" };
  }

  // (c) Only "applied" and "responded" rows are candidates. A row still in
  //     "approved" was never actually sent by the user, so a confirmation
  //     e-mail mentioning that company does not mean what it looks like -
  //     and "interview" / "rejected" / "offer" are past this pass's remit.
  const candidates = sameCompany.filter((application) => ELIGIBLE_STATUSES.includes(application.status));
  if (candidates.length === 0) {
    return { outcome: "skip", reason: "no-eligible-application" };
  }

  // (d) Two applications at the same company and one e-mail: there is no
  //     honest way to pick. Journal it and let the user decide.
  if (candidates.length > 1) {
    return { outcome: "skip", reason: "ambiguous-multiple-applications" };
  }

  const application = candidates[0]!;
  const targetStatus = TARGET_STATUS_BY_KIND[email.kind];

  // (e) Status rules. A confirmation (targetStatus null) skips both checks:
  //     it only ever adds a note.
  if (targetStatus !== null) {
    if (application.status === targetStatus) {
      return { outcome: "skip", reason: "status-already-set", application };
    }
    if (!(ALLOWED_TRANSITIONS[application.status] ?? []).includes(targetStatus)) {
      return { outcome: "skip", reason: "transition-not-allowed", application };
    }
  }

  // (f) The rejection guard. Marking something rejected is the move the user
  //     is least likely to notice and most likely to be hurt by - a job they
  //     quietly stop chasing - so a company match alone is not enough.
  if (email.kind === "rejection") {
    const others = sameCompany.filter((row) => row.id !== application.id);
    const namesThisRole = titleLikelyMatches(email.jobTitleGuess, application.title);

    if (others.length > 0) {
      // Several applications at this company: only a positive identification
      // will do. The e-mail must name a role, that role must plausibly be
      // this application's, and it must NOT also plausibly be one of the
      // others. A rejection for the internship must never close the
      // full-time role still in play.
      const namesAnotherRole = others.some((row) => titleLikelyMatches(email.jobTitleGuess, row.title));
      if (!namesThisRole || namesAnotherRole) {
        return { outcome: "skip", reason: "rejection-role-ambiguous", application };
      }
    } else if (email.jobTitleGuess.trim().length > 0 && !namesThisRole) {
      // Only one application at this company on file - but the e-mail names
      // a role, and it is not this one. The tracker is not the whole truth:
      // people apply to the same employer through other channels, and
      // JobBlast only knows about what went through JobBlast.
      //
      // This case is not hypothetical. It is what the author's own mailbox
      // contained on the day this was written: two Workday rejections from
      // one employer, for "Ingenieur Developpement Logiciels Embarques" and
      // "Order Engineer", while the tracker held a single row for that
      // employer with a third title entirely. Matching on company alone
      // would have closed an application that nobody had rejected.
      //
      // An e-mail that names no role at all still passes: that is the
      // ambiguity the single-application case is allowed to resolve in
      // favour of acting.
      return { outcome: "skip", reason: "rejection-role-mismatch", application };
    }
  }

  return { outcome: "match", application, targetStatus };
}

// ---------------------------------------------------------------------------
// 3. Journal
// ---------------------------------------------------------------------------

export type JournalEntry = {
  ts: string;
  mode: "live" | "dry-run";
  /** Stable per-e-mail identity, used to not act on the same message twice. */
  key: string;
  decision: "acted" | "skipped";
  reason: SkipReason | "applied";
  email: GmailEmail;
  application?: {
    id: number;
    company: string;
    title: string;
    fromStatus: string;
    toStatus: string;
  };
  noteAppended?: string;
};

/**
 * Identity of an e-mail across runs. Built from the normalized company plus
 * the fields the model reads straight off the message (kind, date, sender)
 * rather than from anything it composes, so the same message produces the
 * same key on every pass even if the excerpt is worded differently.
 */
export function emailKey(email: GmailEmail): string {
  return [normalizeCompany(email.company), email.kind, email.date, email.from.toLowerCase()].join("|");
}

/**
 * Keys this pass has already acted on for real. Dry-run entries are
 * deliberately excluded: a dry run is a rehearsal, and it must not stop the
 * live run that follows it from doing the work.
 */
function readActedKeys(): Set<string> {
  const keys = new Set<string>();

  let raw: string;
  try {
    raw = fs.readFileSync(JOURNAL_FILE, "utf8");
  } catch {
    return keys; // no journal yet
  }

  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    try {
      const entry = JSON.parse(trimmed) as Partial<JournalEntry>;
      if (entry.mode === "live" && entry.decision === "acted" && typeof entry.key === "string") {
        keys.add(entry.key);
      }
    } catch {
      // A truncated last line (killed mid-write) must not blind the dedup for
      // every other entry, so bad lines are stepped over rather than fatal.
    }
  }
  return keys;
}

function appendJournal(entry: JournalEntry): void {
  try {
    fs.mkdirSync(path.dirname(JOURNAL_FILE), { recursive: true });
    fs.appendFileSync(JOURNAL_FILE, `${JSON.stringify(entry)}\n`, "utf8");
  } catch (err) {
    logger.warn({ err }, "Gmail sync: failed to append to the decision journal");
  }
}

// ---------------------------------------------------------------------------
// 4. Apply
// ---------------------------------------------------------------------------

/**
 * The line added to `applications.notes`. Dated with today rather than the
 * e-mail's own date, because it records when the tracker learned this.
 * Plain punctuation only - these notes are rendered in the UI and in the
 * generated PDFs.
 */
export function buildNoteLine(email: GmailEmail, today: string): string {
  const label = NOTE_LABEL_BY_KIND[email.kind];
  const sender = email.from.trim() || "an unknown sender";
  const parts = [`[gmail-sync ${today}] ${label} from ${sender}`];
  if (email.excerpt.trim()) parts.push(email.excerpt.trim());
  return parts.join(" - ");
}

/** Appends `line` to `notes`, never replacing what is already there. */
function appendNote(notes: string, line: string): string {
  return notes.trim().length === 0 ? line : `${notes.replace(/\s+$/, "")}\n${line}`;
}

// ---------------------------------------------------------------------------
// The pass
// ---------------------------------------------------------------------------

let passRunning = false;

export type GmailSyncOptions = {
  /** Run even if the last run was under 3h ago (manual / verification runs). */
  ignoreThrottle?: boolean;
};

export type GmailSyncSummary = {
  emailsRead: number;
  acted: number;
  skipped: number;
  dryRun: boolean;
};

/**
 * One full cycle: read the mailbox, decide, apply, journal.
 *
 * No-ops when `gmailSync.enabled` is false, when the provider cannot give a
 * read-only Gmail agent, when a pass is already running, or when the last
 * run was under 3h ago. Never throws: a failure anywhere leaves the tracker
 * untouched and is logged, same contract as the other periodic passes.
 */
export async function runGmailSyncPass(
  userId: string,
  options: GmailSyncOptions = {},
): Promise<GmailSyncSummary | null> {
  if (passRunning) {
    logger.debug("Gmail sync: a pass is already running, skipping this trigger");
    return null;
  }

  const { enabled, dryRun, lookbackDays } = loadConfig().gmailSync;
  if (!enabled) {
    logger.debug("Gmail sync: disabled via config (gmailSync.enabled=false)");
    return null;
  }

  // Checked before the throttle so an unsupported provider never burns the
  // once-per-3h slot on a run that cannot happen.
  const provider = await gmailAgent(userId);
  if (!provider) return null;

  if (!options.ignoreThrottle && shouldSkipDueToFrequency()) {
    logger.info("Gmail sync: skipped, last run was under 3h ago");
    return null;
  }

  passRunning = true;
  try {
    // Marked before the slow agent call, so a crash mid-flight or a second
    // trigger arriving during the call cannot produce back-to-back runs.
    markRan();

    const emails = await readApplicationEmails(provider, lookbackDays);
    if (emails.length === 0) {
      logger.info({ lookbackDays }, "Gmail sync: no application-related e-mails found");
      return { emailsRead: 0, acted: 0, skipped: 0, dryRun };
    }

    const rows = await listApplications(userId);
    // A mutable working copy: two e-mails in one run can concern the same
    // application, and the second decision has to see what the first did
    // (both for the status rules and so its note is appended, not lost to a
    // stale-read overwrite). Mutated in dry-run too, so a rehearsal shows
    // the same sequence the live run will take.
    const applications: TrackedApplication[] = rows.map((row) => ({
      id: row.id,
      title: row.title,
      company: row.company,
      status: row.status,
      notes: row.notes,
    }));

    const actedKeys = readActedKeys();
    const today = new Date().toISOString().slice(0, 10);
    const mode = dryRun ? "dry-run" : "live";
    let acted = 0;
    let skipped = 0;

    const journal = (entry: Omit<JournalEntry, "ts" | "mode">): void => {
      appendJournal({ ts: new Date().toISOString(), mode, ...entry });
    };

    for (const email of emails) {
      const key = emailKey(email);

      // The lookback window (days) is far wider than the interval between
      // runs (hours), so most e-mails on most runs land here.
      if (actedKeys.has(key)) {
        skipped++;
        journal({ key, decision: "skipped", reason: "already-processed", email });
        continue;
      }

      const evaluation = evaluateEmail(email, applications);
      if (evaluation.outcome === "skip") {
        skipped++;
        const skipEntry: Omit<JournalEntry, "ts" | "mode"> = {
          key,
          decision: "skipped",
          reason: evaluation.reason,
          email,
        };
        if (evaluation.application) {
          skipEntry.application = {
            id: evaluation.application.id,
            company: evaluation.application.company,
            title: evaluation.application.title,
            fromStatus: evaluation.application.status,
            toStatus: evaluation.application.status,
          };
        }
        journal(skipEntry);
        continue;
      }

      const { application, targetStatus } = evaluation;
      const noteLine = buildNoteLine(email, today);

      // Belt to the journal's braces: if this exact line is already in the
      // notes (a journal deleted by hand, a restored database), adding
      // nothing is better than adding it twice.
      if (application.notes.includes(noteLine) && targetStatus === null) {
        skipped++;
        journal({ key, decision: "skipped", reason: "already-noted", email });
        continue;
      }

      const fromStatus = application.status;
      const toStatus = targetStatus ?? fromStatus;
      const nextNotes = application.notes.includes(noteLine)
        ? application.notes
        : appendNote(application.notes, noteLine);

      if (!dryRun) {
        try {
          await updateApplication(userId, application.id, {
            status: toStatus,
            notes: nextNotes,
          });
        } catch (err) {
          skipped++;
          logger.error({ err, applicationId: application.id }, "Gmail sync: database update failed, leaving the row untouched");
          continue;
        }
      }

      // An interview invitation read out of the mailbox queues a preparation
      // brief, exactly as PATCH /applications/:id does when the user moves
      // the row by hand - one shared helper, so both paths behave the same.
      // Never in a dry run: queueing is a write.
      if (!dryRun && toStatus === "interview" && fromStatus !== "interview") {
        await ensureInterviewBrief(userId, application.id);
      }

      // The working copy moves whether or not this was a dry run; the
      // database only moved if it was not.
      application.status = toStatus;
      application.notes = nextNotes;
      actedKeys.add(key);
      acted++;

      journal({
        key,
        decision: "acted",
        reason: "applied",
        email,
        application: {
          id: application.id,
          company: application.company,
          title: application.title,
          fromStatus,
          toStatus,
        },
        noteAppended: noteLine,
      });

      logger.info(
        { applicationId: application.id, fromStatus, toStatus, kind: email.kind, dryRun },
        dryRun ? "Gmail sync: would update application (dry run)" : "Gmail sync: application updated",
      );
    }

    logger.info({ emailsRead: emails.length, acted, skipped, dryRun }, "Gmail sync pass complete");
    return { emailsRead: emails.length, acted, skipped, dryRun };
  } catch (err) {
    logger.error({ err }, "Gmail sync pass failed");
    return null;
  } finally {
    passRunning = false;
  }
}
