// What each job kind actually does, and what one cycle enqueues.
//
// Every handler runs inside runWithUser() for the account it belongs to, so
// loadConfig() and the AI provider factory resolve to that account's settings
// and that account's key - the same ambient-context rule the request path
// uses (docs/SAAS-ARCHITECTURE.md section 4, layer 1).
//
// The four kinds, and why the split is where it is:
//
//   postings.refresh  one query signature, one fetch, however many accounts
//                     asked for it. Writes only the shared advert pool, then
//                     enqueues a `user.score` per subscriber. Splitting here
//                     rather than fanning out in memory is what makes the
//                     cycle restartable: the adverts are durable before any
//                     account has looked at them.
//   user.score        one account scores what it has not seen yet, against
//                     its own scoring rules. No AI, no network.
//   user.fit          one account's nightly fit-analysis batch. AI.
//   user.tailor       one letter, for one posting, because the user asked.
//                     Never in bulk in saas: it is the user's own metered
//                     budget (section 6, "the one behavior change worth
//                     calling out").

import type { Job, JobKind } from "@workspace/db";
import { runFitAnalysisPass } from "../ai/fit-analysis";
import { tailorOnePosting } from "../ai/tailor";
import {
  deleteAccountCompletely,
  filterExistingUserIds,
  listActiveUserIds,
  listInactivityCandidates,
  markInactivityWarningSent,
} from "../auth/store";
import { primeUserConfig } from "../config-store";
import { loadConfig } from "../config";
import { inactivityWarningEmail, isEmailEnabled, resolveEmailLocale, sendEmail } from "../email";
import { logger } from "../logger";
import { appOrigin, IS_SAAS } from "../mode";
import { decideInactivityAction } from "./inactivity-selection";
import { fetchSignatureIntoPool, scorePostingsForUser, sourceDisplayName } from "../sources/refresh";
import {
  groupBySignature,
  SOURCE_IDS,
  sourceQueries,
  type SignatureGroup,
  type SourceId,
} from "../sources/signature";
import { runWithUser } from "../user-context";
import { prunePostings, sweepExpiredSessions } from "./hygiene";
import { enqueueJob } from "./store";

/** How far back a `user.score` job looks for adverts it has not scored yet. */
const SCORE_LOOKBACK_MS = 6 * 60 * 60 * 1000;

/** How many postings one nightly fit-analysis batch analyzes per account. */
const FIT_BATCH_SIZE = 10;

/**
 * Runs `fn` as `userId`, with that account's configuration primed and
 * ambient - the job-side equivalent of what the auth middleware does for a
 * request. Priming only means anything in `saas`, where loadConfig() reads
 * per-account settings; in `selfhosted` it reads the file, so the query would
 * be wasted work.
 */
async function asUser<T>(userId: string, fn: () => Promise<T>): Promise<T> {
  if (IS_SAAS) await primeUserConfig(userId);
  return runWithUser(userId, fn);
}

// ---------------------------------------------------------------------------
// Enqueueing a cycle
// ---------------------------------------------------------------------------

/**
 * The work list for one refresh cycle: which fetches have to happen, and who
 * is waiting for each.
 *
 * Reading every account's configuration to compute this is the price of
 * sharing fetches, and it is a cheap one: the configs are already cached per
 * account, and the whole point is that the number of *fetches* grows with
 * distinct signatures rather than with accounts.
 */
export async function planRefreshCycle(userIds: readonly string[]): Promise<SignatureGroup[]> {
  const perUser: Array<{ userId: string; queries: ReturnType<typeof sourceQueries> }> = [];
  for (const userId of userIds) {
    try {
      const queries = await asUser(userId, async () => sourceQueries(loadConfig()));
      perUser.push({ userId, queries });
    } catch (err) {
      logger.warn({ err }, "Refresh cycle: skipping an account whose configuration would not load");
    }
  }
  return groupBySignature(perUser);
}

/**
 * Enqueues one refresh cycle. Returns how many fetches it scheduled, which is
 * the number the doc asks to see in the log every cycle: a jump in it means
 * signature canonicalization regressed and the polite request budget is going
 * with it (section 9, step E3).
 */
export async function enqueueRefreshCycle(): Promise<{ accounts: number; signatures: number }> {
  const userIds = await listActiveUserIds();
  const groups = await planRefreshCycle(userIds);

  let scheduled = 0;
  for (const group of groups) {
    const id = await enqueueJob({
      kind: "postings.refresh",
      userId: null,
      payload: { source: group.source, signature: group.signature, subscribers: group.subscribers },
      dedupeKey: `postings.refresh:${group.signature}`,
    });
    if (id !== null) scheduled++;
  }

  logger.info(
    { accounts: userIds.length, signatures: groups.length, scheduled },
    "Refresh cycle planned: one fetch per query signature",
  );
  return { accounts: userIds.length, signatures: groups.length };
}

/**
 * Enqueues the fetches one account is waiting on, for the "Refresh now"
 * button. Dedupe means an account clicking it during a cycle joins the
 * pending fetch rather than starting a second one, and the fan-out still
 * reaches every other subscriber.
 */
export async function enqueueRefreshForUser(userId: string): Promise<number> {
  const groups = await planRefreshCycle([userId]);
  let scheduled = 0;
  for (const group of groups) {
    const id = await enqueueJob({
      kind: "postings.refresh",
      userId: null,
      payload: { source: group.source, signature: group.signature, subscribers: group.subscribers },
      dedupeKey: `postings.refresh:${group.signature}`,
    });
    if (id !== null) scheduled++;
  }
  // Even when every fetch was already pending, this account still wants its
  // own scoring pass over whatever has landed since it last looked.
  await enqueueJob({
    kind: "user.score",
    userId,
    payload: { since: new Date(Date.now() - SCORE_LOOKBACK_MS).toISOString() },
    dedupeKey: `user.score:${userId}`,
  });
  return scheduled;
}

/**
 * Enqueues the two daily platform-wide hygiene jobs (docs/SAAS-ARCHITECTURE.md
 * section 8 / the v0.4 pre-beta lot's E5 step). Dedupe keys have no date
 * suffix - once a run completes its row is no longer `pending`, so the next
 * day's enqueue is not blocked by it.
 */
export async function enqueueHygieneCycle(): Promise<void> {
  await enqueueJob({ kind: "sessions.sweep", userId: null, dedupeKey: "sessions.sweep:daily" });
  await enqueueJob({ kind: "postings.prune", userId: null, dedupeKey: "postings.prune:daily" });
  await enqueueJob({ kind: "users.inactivity", userId: null, dedupeKey: "users.inactivity:daily" });
}

/** Enqueues one nightly fit-analysis batch per account. */
export async function enqueueFitAnalysisCycle(): Promise<number> {
  const userIds = await listActiveUserIds();
  let scheduled = 0;
  for (const userId of userIds) {
    const id = await enqueueJob({
      kind: "user.fit",
      userId,
      dedupeKey: `user.fit:${userId}`,
    });
    if (id !== null) scheduled++;
  }
  return scheduled;
}

/** The dedupe key one posting's on-demand letter uses, in the queue and in status reads. */
export function tailorDedupeKey(userId: string, postingId: number): string {
  return `user.tailor:${userId}:${postingId}`;
}

/** Asks for one letter, now. Returns null when one is already waiting. */
export function enqueueTailorRequest(userId: string, postingId: number): Promise<number | null> {
  return enqueueJob({
    kind: "user.tailor",
    userId,
    payload: { postingId },
    dedupeKey: tailorDedupeKey(userId, postingId),
  });
}

// ---------------------------------------------------------------------------
// Running one job
// ---------------------------------------------------------------------------

function readString(payload: Record<string, unknown>, key: string): string {
  const value = payload[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Job payload is missing a "${key}" string`);
  }
  return value;
}

function readSubscribers(payload: Record<string, unknown>): string[] {
  const value = payload["subscribers"];
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error('Job payload is missing a non-empty "subscribers" array');
  }
  return value.map(String);
}

function readSource(payload: Record<string, unknown>): SourceId {
  const source = readString(payload, "source");
  // A payload naming a source this build does not have (a downgrade, a typo
  // in a hand-written row) must say so, not crash on an undefined fetcher.
  if (!(SOURCE_IDS as readonly string[]).includes(source)) {
    throw new Error(`Unknown job source "${source}"`);
  }
  return source as SourceId;
}

/**
 * `postings.refresh` carries its subscribers by id inside `payload`, not a
 * FK (it is a platform-wide job - `user_id` is null - see
 * lib/db/src/schema/jobs.ts), so an account deleted after this job was
 * enqueued but before it ran is not automatically scrubbed out the way a
 * per-account job's own `user_id` column would be. That used to fail this
 * whole job the moment it reached that subscriber's `user.score` enqueue (a
 * FK violation inserting a job for a `user_id` that no longer exists),
 * taking every *other* subscriber's scoring pass down with it - not just
 * skipping the deleted one. Filtering the subscriber list against accounts
 * that still exist, once, up front, is what makes this tolerate that: a
 * missing subscriber is skipped and logged, everyone else still gets scored.
 * lib/queue/store.ts's removeUserFromPendingJobs() is the other half of this
 * fix, scrubbing a deleted account out of pending payloads proactively so
 * this filter is normally a no-op rather than the only safety net.
 */
async function runRefresh(payload: Record<string, unknown>): Promise<void> {
  const source = readSource(payload);
  const signature = readString(payload, "signature");
  const subscribers = readSubscribers(payload);

  const existing = await filterExistingUserIds(subscribers);
  const missing = subscribers.length - existing.length;
  if (missing > 0) {
    logger.warn(
      { signature, missing },
      "Refresh job: skipping subscriber(s) whose account no longer exists",
    );
  }

  const first = existing[0];
  if (!first) {
    logger.warn({ signature }, "Refresh job: no remaining subscriber, skipping the fetch");
    return;
  }

  // Fetch under the first subscriber's configuration. Every subscriber has
  // identical parameters for this source - that is what sharing a signature
  // means - so which one is arbitrary, and taking the first keeps it stable.
  const fetchedAt = new Date();
  const result = await asUser(first, () => fetchSignatureIntoPool(source));
  logger.info(
    { source: sourceDisplayName(source), signature, ...result, subscribers: existing.length },
    "Shared fetch complete",
  );

  // The scoring half, one job per waiting account. `since` is the moment
  // before the fetch, so an advert whose lastSeenAt was refreshed by it is
  // inside the window.
  for (const userId of existing) {
    await enqueueJob({
      kind: "user.score",
      userId,
      payload: { since: new Date(fetchedAt.getTime() - SCORE_LOOKBACK_MS).toISOString() },
      dedupeKey: `user.score:${userId}`,
    });
  }
}

async function runScore(userId: string, payload: Record<string, unknown>): Promise<void> {
  const rawSince = payload["since"];
  const since =
    typeof rawSince === "string" && !Number.isNaN(Date.parse(rawSince))
      ? new Date(rawSince)
      : new Date(Date.now() - SCORE_LOOKBACK_MS);
  await asUser(userId, () => scorePostingsForUser(userId, since));
}

async function runFit(userId: string): Promise<void> {
  await asUser(userId, () => runFitAnalysisPass(userId, FIT_BATCH_SIZE));
}

async function runTailor(userId: string, payload: Record<string, unknown>): Promise<void> {
  const postingId = Number(payload["postingId"]);
  if (!Number.isInteger(postingId)) throw new Error('Job payload is missing a "postingId" number');
  await asUser(userId, () => tailorOnePosting(userId, postingId));
}

/**
 * The 11-month warning / 12-month purge pass (G2 lot,
 * docs/SAAS-ARCHITECTURE.md open question 3). isEmailEnabled() is checked
 * twice, deliberately: once here, so a disabled transport skips the account
 * query entirely rather than paying for it every day for nothing, and again
 * inside decideInactivityAction() itself (lib/queue/inactivity-selection.ts),
 * so the fail-safe rule is provably part of the tested decision, not just an
 * early return trusted by inspection.
 *
 * One account's failure (an email that would not send, a delete that hit a
 * database error) is caught and logged, never allowed to stop the loop -
 * the same "no account can take the whole pass down" property runRefresh()
 * now has for a different reason.
 */
async function runInactivityPass(): Promise<void> {
  if (!isEmailEnabled()) {
    logger.info({}, "Inactivity pass: email transport is not configured, skipping");
    return;
  }

  const candidates = await listInactivityCandidates();
  const now = new Date();
  const link = appOrigin() ?? "";

  for (const account of candidates) {
    const action = decideInactivityAction(account, now, true);
    if (action === "none") continue;

    if (action === "warn") {
      const content = inactivityWarningEmail(resolveEmailLocale(account.locale), link);
      try {
        await sendEmail({ to: account.email, subject: content.subject, text: content.text, html: content.html });
        // Only marked sent once the email actually left - if it did not,
        // the next daily run tries again instead of silently giving up.
        await markInactivityWarningSent(account.id, now);
        logger.info({ userId: account.id }, "Inactivity pass: warning sent");
      } catch (err) {
        logger.error({ err, userId: account.id }, "Inactivity pass: warning email failed, will retry");
      }
      continue;
    }

    try {
      await deleteAccountCompletely(account.id, "inactivity");
      logger.info({ userId: account.id }, "Inactivity pass: account deleted after 12 months of inactivity");
    } catch (err) {
      logger.error({ err, userId: account.id }, "Inactivity pass: could not delete an inactive account");
    }
  }
}

/**
 * Dispatches one claimed job. Throwing is how a handler asks for a retry: the
 * worker turns it into a backoff, or a `failed` row once the attempts are
 * spent (lib/queue/store.ts).
 */
export async function runJob(job: Job): Promise<void> {
  const payload = job.payload;
  switch (job.kind as JobKind) {
    case "postings.refresh":
      await runRefresh(payload);
      return;
    case "user.score":
      if (!job.userId) throw new Error("user.score needs a user_id");
      await runScore(job.userId, payload);
      return;
    case "user.fit":
      if (!job.userId) throw new Error("user.fit needs a user_id");
      await runFit(job.userId);
      return;
    case "user.tailor":
      if (!job.userId) throw new Error("user.tailor needs a user_id");
      await runTailor(job.userId, payload);
      return;
    case "sessions.sweep":
      await sweepExpiredSessions();
      return;
    case "postings.prune":
      await prunePostings();
      return;
    case "users.inactivity":
      await runInactivityPass();
      return;
    default:
      throw new Error(`Unknown job kind "${job.kind}"`);
  }
}
