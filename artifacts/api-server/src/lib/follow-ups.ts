// Follow-up nudges (lot H4): "Thales, 13 days without a reply - a follow-up
// is suggested, with the e-mail pre-written" from the app's own vision doc.
//
// This file only decides WHICH applications are worth nudging the user
// about. Nothing here sends anything: lib/ai/follow-up.ts drafts the e-mail
// text, and the user copies it (or opens it via a mailto: link) into their
// own mailbox by hand - see that file's header for the founding rule this
// whole feature is built around.
//
// The rule, exactly:
//   - the row is still "applied" - the moment a reply, interview invite or
//     rejection is read from the mailbox, lib/gmail-sync.ts moves the status
//     away from "applied" (to "responded", "interview" or "rejected"), which
//     is what keeps a row that already got an answer from ever being
//     suggested here. This file trusts that one field completely and does
//     not re-derive it - see gmail-sync.ts's own header for why the matching
//     logic that keeps it correct lives entirely over there.
//   - the account has not already been suggested (and acted on) the maximum
//     number of follow-ups for this row (MAX_SUGGESTED_FOLLOW_UPS)
//   - enough days have passed since whichever happened last: the
//     application itself, or the last follow-up the user confirmed sending.
//     `afterDays` is `followUps.afterDays` in jobblast.config.json, 7 by
//     default.
//
// A follow-up that has already happened once is suggested again after
// another full `afterDays` window, not on a shorter cadence - nagging the
// user daily about the same silence would be worse than saying nothing.

/** How many times a follow-up is ever suggested for one application. */
export const MAX_SUGGESTED_FOLLOW_UPS = 2;

const DAY_MS = 24 * 60 * 60 * 1000;

/** The subset of an `applications` row this selection reasons about. */
export type FollowUpCandidate = {
  status: string;
  appliedAt: Date;
  lastFollowedUpAt: Date | null;
  followUpCount: number;
};

/** Whole days elapsed from `from` to `now`. Never negative (clocks and stray future dates aside). */
export function daysSince(from: Date, now: Date): number {
  return Math.max(0, Math.floor((now.getTime() - from.getTime()) / DAY_MS));
}

/**
 * The instant a follow-up next becomes due: `afterDays` after the
 * application was sent for the very first suggestion, or `afterDays` after
 * the last confirmed follow-up for every one after that.
 */
export function followUpDueAt(application: FollowUpCandidate, afterDays: number): Date {
  const reference = application.lastFollowedUpAt ?? application.appliedAt;
  return new Date(reference.getTime() + afterDays * DAY_MS);
}

/**
 * Whether `application` should be suggested as "needs a follow-up" right
 * now. Pure and deterministic - see the file header for the exact rule this
 * implements.
 */
export function isFollowUpEligible(
  application: FollowUpCandidate,
  now: Date,
  afterDays: number,
): boolean {
  if (application.status !== "applied") return false;
  if (application.followUpCount >= MAX_SUGGESTED_FOLLOW_UPS) return false;
  return now.getTime() >= followUpDueAt(application, afterDays).getTime();
}

/** Filters `applications` down to the ones eligible for a follow-up suggestion right now. */
export function selectFollowUpCandidates<T extends FollowUpCandidate>(
  applications: readonly T[],
  now: Date,
  afterDays: number,
): T[] {
  return applications.filter((application) => isFollowUpEligible(application, now, afterDays));
}

/** `application`, annotated with whether it is eligible right now - the shape the API responds with. */
export function withFollowUpEligibility<T extends FollowUpCandidate>(
  application: T,
  now: Date,
  afterDays: number,
): T & { followUpEligible: boolean } {
  return { ...application, followUpEligible: isFollowUpEligible(application, now, afterDays) };
}
