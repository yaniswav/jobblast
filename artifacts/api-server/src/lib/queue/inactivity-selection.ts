// Pure decision logic behind the "users.inactivity" job (G2 lot,
// docs/SAAS-ARCHITECTURE.md open question 3): who gets a warning email, and
// who gets deleted. The impure shell (reading candidates, sending the email,
// calling deleteAccountCompletely()) lives in lib/queue/handlers.ts - same
// split as lib/queue/hygiene-selection.ts / lib/queue/hygiene.ts, for the
// same reason: this is the one place the timing could be off by a day, and
// it is testable without a database or a clock.
//
// Months are approximated as 30-day stretches throughout, matching how every
// other retention window in this codebase already works (POSTING_RETENTION_DAYS
// is "90 days", not "3 calendar months") - simpler to reason about and to
// test than real calendar arithmetic, and a day or two of slack either way
// makes no practical difference to an account nobody has opened in nearly a
// year.

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** 11 months of inactivity: the account gets a one-time warning email. */
export const INACTIVITY_WARNING_AFTER_DAYS = 11 * 30;

/** 12 months of inactivity: eligible for deletion, provided the warning grace period below has also passed. */
export const INACTIVITY_DELETE_AFTER_DAYS = 12 * 30;

/** How long an account gets after its warning before deletion actually happens. */
export const INACTIVITY_WARNING_GRACE_DAYS = 30;

export type InactivityAccount = {
  /** Null for an account that has never signed in since creation (no session has ever resolved for it). */
  lastSeenAt: Date | null;
  createdAt: Date;
  /** Null until the one-time warning has been sent for the current inactive stretch. */
  inactivityWarningSentAt: Date | null;
};

export type InactivityAction = "none" | "warn" | "delete";

/**
 * `emailEnabled` is a parameter, not a module-level read, on purpose: the
 * fail-safe rule ("no working email transport means never warn and never
 * delete") has to be exactly as testable as the timing math it guards, not
 * a side comment trusted by inspection.
 */
export function decideInactivityAction(
  account: InactivityAccount,
  now: Date,
  emailEnabled: boolean,
): InactivityAction {
  if (!emailEnabled) return "none";

  const reference = account.lastSeenAt ?? account.createdAt;
  const inactiveDays = (now.getTime() - reference.getTime()) / MS_PER_DAY;

  if (account.inactivityWarningSentAt !== null) {
    const graceDays = (now.getTime() - account.inactivityWarningSentAt.getTime()) / MS_PER_DAY;
    if (inactiveDays >= INACTIVITY_DELETE_AFTER_DAYS && graceDays >= INACTIVITY_WARNING_GRACE_DAYS) {
      return "delete";
    }
    return "none"; // already warned, grace period not over yet
  }

  if (inactiveDays >= INACTIVITY_WARNING_AFTER_DAYS) return "warn";
  return "none";
}
