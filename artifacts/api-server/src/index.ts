import { LOCAL_USER_ID } from "@workspace/db";
import app from "./app";
import { runFitAnalysisPass } from "./lib/ai/fit-analysis";
import { runInterviewBriefPass } from "./lib/ai/interview-brief";
import { logAiProviderStatus } from "./lib/ai/provider";
import { runTailoringPass } from "./lib/ai/tailor";
import { ensureLocalUser } from "./lib/auth/store";
import { runGmailSyncPass } from "./lib/gmail-sync";
import { logger } from "./lib/logger";
import { IS_SAAS, MODE, runStartupPreflight } from "./lib/mode";
import { startQueueWorker, stopQueueWorker } from "./lib/queue/worker";
import { refreshJobListings } from "./lib/sources/refresh";
import { runWithUser } from "./lib/user-context";

const JOB_REFRESH_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6 hours
const TAILORING_INTERVAL_MS = 30 * 60 * 1000; // 30 minutes
const TAILORING_BATCH_SIZE = 10;

// Tailoring, then fit analysis, then Gmail sync, then interview briefs -
// sequential, never in parallel, so at most one AI provider call is ever in
// flight at a time. Gmail sync has its own 3-hour throttle, so on most
// triggers of this 30-minute cadence it returns immediately without spawning
// a CLI. Interview briefs go last, after Gmail sync, because that pass is
// one of the two things that can queue one (an interview invitation read out
// of the mailbox); it also returns immediately whenever nothing is pending,
// which is the normal case.
async function runAiPasses(userId: string): Promise<void> {
  await runTailoringPass(userId, TAILORING_BATCH_SIZE).catch((err: unknown) => {
    logger.error({ err }, "AI tailoring pass failed");
  });
  await runFitAnalysisPass(userId, TAILORING_BATCH_SIZE).catch((err: unknown) => {
    logger.error({ err }, "AI fit-analysis pass failed");
  });
  await runGmailSyncPass(userId).catch((err: unknown) => {
    logger.error({ err }, "Gmail sync pass failed");
  });
  await runInterviewBriefPass(userId).catch((err: unknown) => {
    logger.error({ err }, "Interview brief pass failed");
  });
}

/**
 * The self-hosted background schedule: two timers acting for the one
 * implicit account, exactly as before this became multi-tenant.
 *
 * In `saas` these do not run at all - the job queue does that work instead
 * (lib/queue/worker.ts), fetching once per query signature and scoring per
 * account. Self-hosted deliberately bypasses the queue: it has one account,
 * one CLI call in flight at a time and a six-hour cadence that its owner is
 * used to, and a queue would buy it nothing but a new way to break.
 */
function startSelfHostedSchedule(): void {
  const run = (label: string, fn: () => Promise<unknown>): Promise<void> =>
    runWithUser(LOCAL_USER_ID, fn)
      .then(() => undefined)
      .catch((err: unknown) => {
        logger.error({ err }, label);
      });

  // Populate/refresh real job listings without blocking server startup, then
  // kick off the AI passes (also non-blocking) once it settles.
  void run("Initial job refresh failed", () => refreshJobListings(LOCAL_USER_ID)).finally(() => {
    void run("Initial AI passes failed", () => runAiPasses(LOCAL_USER_ID));
  });

  setInterval(() => {
    void run("Scheduled job refresh failed", () => refreshJobListings(LOCAL_USER_ID)).finally(() => {
      void run("Post-refresh AI passes failed", () => runAiPasses(LOCAL_USER_ID));
    });
  }, JOB_REFRESH_INTERVAL_MS);

  // Independent 30-minute cadence so the AI passes also progress between
  // 6-hour refreshes (e.g. catching up on a backlog after startup).
  setInterval(() => {
    void run("Scheduled AI passes failed", () => runAiPasses(LOCAL_USER_ID));
  }, TAILORING_INTERVAL_MS);
}

runStartupPreflight();

const rawPort = process.env["PORT"];

if (!rawPort) {
  throw new Error(
    "PORT environment variable is required but was not provided.",
  );
}

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

const server = app.listen(port, (err) => {
  if (err) {
    logger.error({ err }, "Error listening on port");
    process.exit(1);
  }

  logger.info({ port, mode: MODE }, "Server listening");

  if (IS_SAAS) {
    // No per-account timers here: the queue is the only thing that acts for
    // an account in saas, and it decides whose turn it is.
    startQueueWorker();
    return;
  }

  void logAiProviderStatus(LOCAL_USER_ID).catch((err: unknown) => {
    logger.warn({ err }, "Could not log the AI provider status");
  });

  ensureLocalUser()
    .then(startSelfHostedSchedule)
    .catch((seedErr: unknown) => {
      logger.error({ err: seedErr }, "Could not seed the local user; background passes are off");
    });
});

/**
 * A container's `docker stop` (or `docker compose down`/`restart`) sends
 * SIGTERM and waits out a grace period before SIGKILL; a plain Ctrl+C sends
 * SIGINT. Without this, the process is killed mid-poll and whatever the
 * queue worker just claimed stays `status = 'running'` for the rest of its
 * 20-minute lease (lib/queue/store.ts's LEASE_MS) before the next process
 * reclaims it - harmless once, a real orphan-job problem after every
 * redeploy. `stopQueueWorker()` only clears its own timers (no in-flight
 * drain - see its own doc comment), which is why closing the HTTP server
 * right after is what actually lets the process exit promptly.
 */
let shuttingDown = false;
function shutdown(signal: NodeJS.Signals): void {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, "Shutting down");

  if (IS_SAAS) {
    stopQueueWorker();
  }

  server.close((closeErr) => {
    if (closeErr) {
      logger.error({ err: closeErr }, "Error while closing the server");
      process.exit(1);
      return;
    }
    logger.info("Server closed cleanly");
    process.exit(0);
  });

  // server.close() only stops new connections and waits for in-flight ones
  // to finish; force the exit if that somehow hangs, rather than leave a
  // container stuck between `docker stop`'s SIGTERM and its SIGKILL timeout.
  setTimeout(() => {
    logger.warn("Forcing exit after shutdown timed out");
    process.exit(1);
  }, 10_000).unref();
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
