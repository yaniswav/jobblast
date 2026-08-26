// Pure logic for the G1 onboarding wizard (saas only). The impure shell
// around this - reading the account's profile and stored settings, writing
// `users.onboarding_completed_at`, enqueueing the first refresh - lives in
// lib/repo/onboarding.ts and routes/onboarding.ts.
//
// Detection: a nullable `users.onboarding_completed_at` timestamp, not a
// heuristic over profile/config contents. Two reasons:
//
//   1. It needs to flip exactly once, from an explicit user action (the
//      "Finish" button), which is also the moment the first refresh cycle is
//      enqueued. Inferring "done" from data shape gives no single point to
//      hang that side effect off - re-deriving it on every page load would
//      either re-enqueue a refresh on every visit (wasteful, though harmless
//      thanks to the queue's dedupe keys) or need a second signal anyway.
//   2. It is unambiguous. "The profile looks filled in" is a fine SIGNAL for
//      which step to resume on (see resumeOnboardingStep below), but a poor
//      GATE: a user who blanks a field back out while editing their profile
//      later must not be bounced back into the wizard.
//
// Resuming mid-wizard ("quitter et reprendre") does not need its own stored
// step counter: the step to resume on is just the first one whose data is
// still missing, deduced from the same profile/settings rows the wizard
// itself writes to. That is what this function does, and why it is safe to
// call on every status check rather than only once.

export type OnboardingStep = "profile" | "criteria" | "byok";

/**
 * Which step an incomplete account should land on. `hasResume` and
 * `hasCriteria` are computed by the caller against real stored data (see
 * lib/repo/profile.ts's `hasRealResume` and lib/repo/onboarding.ts's
 * `hasStoredSearchCriteria`) - never against a Zod-defaulted config, whose
 * defaults are non-empty and would make every fresh account look "already
 * configured".
 *
 * BYOK is always reachable last and never blocks completion: the wizard's
 * own "skip" step marks it seen by setting `ai.provider` explicitly (to a
 * BYOK provider, or to "none"), which is a decision the Finish step commits
 * regardless of this function.
 */
export function resumeOnboardingStep(input: { hasResume: boolean; hasCriteria: boolean }): OnboardingStep {
  if (!input.hasResume) return "profile";
  if (!input.hasCriteria) return "criteria";
  return "byok";
}
