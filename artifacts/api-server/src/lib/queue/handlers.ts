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
import { listActiveUserIds } from "../auth/store";
import { primeUserConfig } from "../config-store";
import { loadConfig } from "../config";
import { logger } from "../logger";
import { IS_SAAS } from "../mode";
import { fetchSignatureIntoPool, scorePostingsForUser, sourceDisplayName } from "../sources/refresh";
import {
  groupBySignature,
  SOURCE_IDS,
  sourceQueries,
  type SignatureGroup,
  type SourceId,
} from "../sources/signature";
import { runWithUser } from "../user-context";
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

async function runRefresh(payload: Record<string, unknown>): Promise<void> {
  const source = readSource(payload);
  const signature = readString(payload, "signature");
  const subscribers = readSubscribers(payload);
  const first = subscribers[0];
  if (!first) throw new Error("A refresh job needs at least one subscriber");

  // Fetch under the first subscriber's configuration. Every subscriber has
  // identical parameters for this source - that is what sharing a signature
  // means - so which one is arbitrary, and taking the first keeps it stable.
  const fetchedAt = new Date();
  const result = await asUser(first, () => fetchSignatureIntoPool(source));
  logger.info(
    { source: sourceDisplayName(source), signature, ...result, subscribers: subscribers.length },
    "Shared fetch complete",
  );

  // The scoring half, one job per waiting account. `since` is the moment
  // before the fetch, so an advert whose lastSeenAt was refreshed by it is
  // inside the window.
  for (const userId of subscribers) {
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
    default:
      throw new Error(`Unknown job kind "${job.kind}"`);
  }
}
