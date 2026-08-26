// The in-process worker: poll, claim, run, record. One loop, no threads.
//
// v0.3 is a single process (docs/SAAS-ARCHITECTURE.md section 7), so this is
// a `setInterval` that claims what it has capacity for and runs those jobs
// concurrently. The claim query is written to be safe with several workers
// anyway (FOR UPDATE SKIP LOCKED plus lease reclaim), so scaling out later is
// a deployment change rather than a rewrite.
//
// Concurrency, from section 6's table:
//
//   selfhosted  1 globally, so the existing "at most one CLI call in flight"
//               invariant survives untouched. `claude -p` is expensive and
//               the machine is shared with its owner.
//   saas        JOBBLAST_WORKER_CONCURRENCY, default 4: these are HTTPS calls
//               to different accounts' endpoints and are trivially parallel.
//
// In-flight jobs per account is 1 in both modes, which together with the
// round-robin in fairness.ts is what stops one account's backlog from
// crowding everyone else out.

import { randomUUID } from "node:crypto";
import { logger } from "../logger";
import { IS_SAAS } from "../mode";
import type { FairnessCaps } from "./fairness";
import { enqueueFitAnalysisCycle, enqueueRefreshCycle, runJob } from "./handlers";
import { claimJobs, completeJob, failJob, purgeFinishedJobs, reclaimStaleJobs } from "./store";

const POLL_INTERVAL_MS = 5_000;
/** Section 6: the shared refresh is hourly, because it is amortized across accounts. */
const REFRESH_CYCLE_MS = 60 * 60 * 1000;
/** Fit analysis is batched rather than immediate: short calls, and it is what makes the queue triageable. */
const FIT_CYCLE_MS = 6 * 60 * 60 * 1000;
const SWEEP_INTERVAL_MS = 24 * 60 * 60 * 1000;
/** Finished rows are kept this long, so "why did my letter not appear" is answerable. */
const FINISHED_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

const DEFAULT_SAAS_CONCURRENCY = 4;

function configuredConcurrency(): number {
  if (!IS_SAAS) return 1;
  const raw = Number(process.env["JOBBLAST_WORKER_CONCURRENCY"]);
  return Number.isInteger(raw) && raw > 0 ? raw : DEFAULT_SAAS_CONCURRENCY;
}

const WORKER_ID = `${process.pid}-${randomUUID().slice(0, 8)}`;

let timers: NodeJS.Timeout[] = [];
let polling = false;
let inFlight = 0;

/** One poll: reclaim what a dead process left, then claim and run what fits. */
async function poll(): Promise<void> {
  if (polling) return;
  polling = true;
  try {
    await reclaimStaleJobs();

    const caps: FairnessCaps = {
      capacity: configuredConcurrency() - inFlight,
      // One job per account at a time, in both modes (section 6's table).
      maxPerOwner: 1,
    };
    if (caps.capacity <= 0) return;

    const claimed = await claimJobs(WORKER_ID, caps);
    if (claimed.length === 0) return;

    inFlight += claimed.length;
    await Promise.all(
      claimed.map(async (job) => {
        const startedAt = Date.now();
        try {
          await runJob(job);
          await completeJob(job.id);
          logger.info(
            { jobId: job.id, kind: job.kind, ms: Date.now() - startedAt, ok: true },
            "Queue: job done",
          );
        } catch (err) {
          const message = (err as Error).message;
          const { retrying } = await failJob(job, message);
          logger.error(
            { jobId: job.id, kind: job.kind, ms: Date.now() - startedAt, ok: false, retrying, err },
            retrying ? "Queue: job failed, will retry" : "Queue: job failed for good",
          );
        } finally {
          inFlight--;
        }
      }),
    );
  } catch (err) {
    logger.error({ err }, "Queue: poll failed");
  } finally {
    polling = false;
  }
}

function every(ms: number, label: string, fn: () => Promise<unknown>): void {
  const timer = setInterval(() => {
    void fn().catch((err: unknown) => {
      logger.error({ err }, label);
    });
  }, ms);
  // The queue must never be the reason a process refuses to exit.
  timer.unref?.();
  timers.push(timer);
}

/**
 * Starts the worker and the tickers that feed it. Idempotent: calling it
 * twice does not double the timers.
 */
export function startQueueWorker(): void {
  if (timers.length > 0) return;

  logger.info(
    { workerId: WORKER_ID, concurrency: configuredConcurrency() },
    "Queue worker started",
  );

  every(POLL_INTERVAL_MS, "Queue: poll failed", poll);
  every(REFRESH_CYCLE_MS, "Queue: refresh cycle could not be enqueued", enqueueRefreshCycle);
  every(FIT_CYCLE_MS, "Queue: fit-analysis cycle could not be enqueued", enqueueFitAnalysisCycle);
  every(SWEEP_INTERVAL_MS, "Queue: sweep failed", () =>
    purgeFinishedJobs(new Date(Date.now() - FINISHED_RETENTION_MS)),
  );

  // A cycle at boot too, so a restart does not mean an hour of nothing.
  void enqueueRefreshCycle().catch((err: unknown) => {
    logger.error({ err }, "Queue: initial refresh cycle could not be enqueued");
  });
}

/**
 * Stops every timer. There is deliberately no graceful drain: a job killed
 * mid-flight keeps its `running` row, and the next process reclaims it once
 * the lease expires, which is the same path a crash takes and therefore the
 * one worth having tested.
 */
export function stopQueueWorker(): void {
  for (const timer of timers) clearInterval(timer);
  timers = [];
}
