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
 * In `saas` these do not run at all. Aggregation and the AI passes move onto
 * the per-user job queue in a later lot; until then a SaaS process serves
 * requests and nothing else, rather than silently doing one account's work
 * on a timer.
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

app.listen(port, (err) => {
  if (err) {
    logger.error({ err }, "Error listening on port");
    process.exit(1);
  }

  logger.info({ port, mode: MODE }, "Server listening");

  if (IS_SAAS) {
    logger.info(
      "saas mode: background aggregation and AI passes are off (they move onto the per-user job queue in a later lot)",
    );
    return;
  }

  logAiProviderStatus();

  ensureLocalUser()
    .then(startSelfHostedSchedule)
    .catch((seedErr: unknown) => {
      logger.error({ err: seedErr }, "Could not seed the local user; background passes are off");
    });
});
