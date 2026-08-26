// Pure logic for the dashboard's "your first batch is on its way" state
// (G1 onboarding lot). The empty review queue is ambiguous on its own: it
// means either "nothing has ever arrived for this account yet" (show the
// fetching message) or "everything was reviewed or skipped" (show the plain
// empty state). `hasAnyPostings` tells them apart; the account-age window
// keeps the fetching message from lying forever if a genuinely narrow set of
// search criteria keeps producing zero matches.

/** How long after account creation an empty queue is still explained as "still fetching" rather than "nothing matched". */
export const FIRST_BATCH_WINDOW_MS = 48 * 60 * 60 * 1000;

export function isFirstBatchPending(input: {
  hasAnyPostings: boolean;
  accountCreatedAt: Date;
  now: Date;
}): boolean {
  if (input.hasAnyPostings) return false;
  return input.now.getTime() - input.accountCreatedAt.getTime() < FIRST_BATCH_WINDOW_MS;
}
