// Timeline events for one application (lot I1): a fire-and-forget audit
// trail of everything that happened to it - applied, status changes (manual
// or detected from Gmail), confirmed follow-ups, personal notes, detected
// e-mails and generated interview briefs. One place to see the whole story,
// instead of it being scattered across the free-text `notes` column and the
// Gmail sync journal file.
//
// Every write goes through recordApplicationEvent() below, which NEVER
// throws: the timeline is a read model for humans, not something anything
// else in the app depends on, so a failed insert (a bad connection, a
// migration not yet applied) must never fail the action that triggered it -
// same contract as ensureInterviewBrief() in lib/ai/interview-brief.ts.
// Failures are logged at warn and swallowed.
//
// PRIVACY: an e-mail's raw excerpt (the closest thing this app has to a
// "body" - see gmail-sync.ts's GmailEmail.excerpt, quoted verbatim from the
// message) NEVER reaches this table, and there is no code path here that
// even has access to it. buildEmailSubject() below builds a short synthetic
// label out of structured fields the read pass already classified (kind,
// company, sender) instead, and every subject-shaped string is capped at
// MAX_SUBJECT_CHARS by truncate().

import { logger } from "./logger";
import { insertApplicationEvent } from "./repo/application-events";
import type { ApplicationEvent, InsertApplicationEventInput } from "./repo/application-events";

export type { ApplicationEvent, InsertApplicationEventInput } from "./repo/application-events";

export const APPLICATION_EVENT_KINDS = [
  "applied",
  "status_changed",
  "followed_up",
  "note_added",
  "email_detected",
  "brief_generated",
] as const;
export type ApplicationEventKind = (typeof APPLICATION_EVENT_KINDS)[number];

export function isApplicationEventKind(value: string): value is ApplicationEventKind {
  return (APPLICATION_EVENT_KINDS as readonly string[]).includes(value);
}

/** Subject-like strings (never raw e-mail content) are capped here. */
export const MAX_SUBJECT_CHARS = 120;
/** A personal note (POST /applications/:id/notes) is capped here. */
export const MAX_NOTE_CHARS = 2000;

/** Collapses whitespace and caps length - same idea as gmail-sync.ts's tidy(). */
export function truncate(value: string, maxChars: number): string {
  const oneLine = value.replace(/\s+/g, " ").trim();
  return oneLine.length > maxChars ? `${oneLine.slice(0, maxChars - 1).trimEnd()}…` : oneLine;
}

// ---------------------------------------------------------------------------
// status_changed
// ---------------------------------------------------------------------------

export type StatusChangeOrigin = "manual" | "gmail";

export type StatusChangedPayload = {
  from: string;
  to: string;
  origin: StatusChangeOrigin;
  /** Only ever set for origin "gmail". A synthetic label - see buildEmailSubject(). */
  subject?: string;
};

/** Builds and validates the payload for a status_changed event. */
export function buildStatusChangedPayload(params: {
  from: string;
  to: string;
  origin: StatusChangeOrigin;
  subject?: string;
}): StatusChangedPayload {
  const payload: StatusChangedPayload = { from: params.from, to: params.to, origin: params.origin };
  if (params.subject && params.subject.trim().length > 0) {
    payload.subject = truncate(params.subject, MAX_SUBJECT_CHARS);
  }
  return payload;
}

// ---------------------------------------------------------------------------
// email_detected
// ---------------------------------------------------------------------------

/** Mirrors gmail-sync.ts's GmailEmailKind - kept separate so this file has no import cycle with it. */
export type DetectedEmailKind = "confirmation" | "reply" | "interview" | "rejection";

/**
 * Why this e-mail is on the timeline at all. Today gmail-sync.ts only ever
 * emits an email_detected event for its "match" outcome (a confirmation
 * e-mail that only adds a note, since a status-moving match already gets its
 * own status_changed event with the same subject in its payload - see this
 * file's header). A declined match (ambiguous rejection, status already set,
 * ...) is deliberately NOT written here: gmail-sync.ts re-evaluates the same
 * e-mail on every cycle within its multi-day lookback window (its own header
 * explains why), and skip outcomes have no dedup key the way an acted-on one
 * does via `actedKeys` - writing one per cycle would spam the timeline with
 * duplicates. Those decisions stay fully recorded in
 * data/gmail-sync-journal.jsonl, which is already documented as the audit
 * trail for "why did this become X". `verdict` is kept as its own field
 * (rather than folding "matched" into `kind`) so a future lot can widen it
 * without changing the payload's shape.
 */
export type EmailDetectedVerdict = "matched";

export type EmailDetectedPayload = {
  kind: DetectedEmailKind;
  verdict: EmailDetectedVerdict;
  subject: string;
};

/**
 * A short, human-readable subject-like label for a Gmail-sync e-mail, built
 * only from fields the read pass already classified (never from `excerpt`,
 * which is the closest thing to the e-mail's body - see this file's header).
 */
export function buildEmailSubject(params: { kindLabel: string; company: string; from: string }): string {
  const sender = params.from.trim();
  const base = sender ? `${params.kindLabel} - ${params.company} (${sender})` : `${params.kindLabel} - ${params.company}`;
  return truncate(base, MAX_SUBJECT_CHARS);
}

/** Builds and validates the payload for an email_detected event. */
export function buildEmailDetectedPayload(params: {
  kind: DetectedEmailKind;
  verdict: EmailDetectedVerdict;
  subject: string;
}): EmailDetectedPayload {
  return { kind: params.kind, verdict: params.verdict, subject: truncate(params.subject, MAX_SUBJECT_CHARS) };
}

// ---------------------------------------------------------------------------
// note_added
// ---------------------------------------------------------------------------

export type NoteAddedPayload = { text: string };

/**
 * Trims a personal note and enforces the length cap. Null when the note is
 * empty or over MAX_NOTE_CHARS - the caller (the POST /applications/:id/notes
 * route) turns that into a 400, never a silently truncated note.
 */
export function normalizeNoteText(raw: string): string | null {
  const trimmed = raw.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_NOTE_CHARS) return null;
  return trimmed;
}

// ---------------------------------------------------------------------------
// followed_up
// ---------------------------------------------------------------------------

export type FollowedUpPayload = { followUpCount: number };

// ---------------------------------------------------------------------------
// applied / brief_generated - no meaningful payload beyond "it happened"
// ---------------------------------------------------------------------------

export type EmptyPayload = Record<string, never>;

export type BriefGeneratedPayload = { chars: number };

// ---------------------------------------------------------------------------
// Write
// ---------------------------------------------------------------------------

export type RecordApplicationEventInput =
  | { kind: "applied"; payload?: EmptyPayload }
  | { kind: "status_changed"; payload: StatusChangedPayload }
  | { kind: "followed_up"; payload: FollowedUpPayload }
  | { kind: "note_added"; payload: NoteAddedPayload }
  | { kind: "email_detected"; payload: EmailDetectedPayload }
  | { kind: "brief_generated"; payload?: BriefGeneratedPayload };

/**
 * The shape of `insertApplicationEvent` (lib/repo/application-events.ts) -
 * named so tests can inject a faithful fake instead of mocking that module.
 * See recordApplicationEvent's `insert` parameter.
 */
export type InsertApplicationEventFn = (
  userId: string,
  input: InsertApplicationEventInput,
) => Promise<ApplicationEvent>;

/**
 * Appends one row to `applicationId`'s timeline. Fire-and-forget: NEVER
 * throws. Every call site (application creation, a status change, a
 * confirmed follow-up, a personal note, a detected e-mail, a finished brief)
 * calls this the same way and does not need its own try/catch.
 *
 * `insert` defaults to the real DB write and every production call site
 * leaves it at that default - it exists so
 * application-events.test.ts can prove the "never throws" contract with a
 * faithful fake insert that fails, instead of mocking ./repo/application-events.
 */
export async function recordApplicationEvent(
  userId: string,
  applicationId: number,
  input: RecordApplicationEventInput,
  occurredAt?: Date,
  insert: InsertApplicationEventFn = insertApplicationEvent,
): Promise<ApplicationEvent | null> {
  try {
    const insertInput: InsertApplicationEventInput = {
      applicationId,
      kind: input.kind,
      payload: input.payload ?? {},
    };
    if (occurredAt) insertInput.occurredAt = occurredAt;
    return await insert(userId, insertInput);
  } catch (err) {
    logger.warn(
      { err, applicationId, kind: input.kind },
      "Application event: failed to record, continuing without it",
    );
    return null;
  }
}
