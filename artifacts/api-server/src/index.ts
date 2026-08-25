import app from "./app";
import { runFitAnalysisPass } from "./lib/ai/fit-analysis";
import { runInterviewBriefPass } from "./lib/ai/interview-brief";
import { logAiProviderStatus } from "./lib/ai/provider";
import { runTailoringPass } from "./lib/ai/tailor";
import { runGmailSyncPass } from "./lib/gmail-sync";
import { logger } from "./lib/logger";
import { refreshJobListings } from "./lib/sources/refresh";

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
async function runAiPasses(): Promise<void> {
  await runTailoringPass(TAILORING_BATCH_SIZE).catch((err: unknown) => {
    logger.error({ err }, "AI tailoring pass failed");
  });
  await runFitAnalysisPass(TAILORING_BATCH_SIZE).catch((err: unknown) => {
    logger.error({ err }, "AI fit-analysis pass failed");
  });
  await runGmailSyncPass().catch((err: unknown) => {
    logger.error({ err }, "Gmail sync pass failed");
  });
  await runInterviewBriefPass().catch((err: unknown) => {
    logger.error({ err }, "Interview brief pass failed");
  });
}

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

  logger.info({ port }, "Server listening");
  logAiProviderStatus();

  // Populate/refresh real job listings without blocking server startup, then
  // kick off the AI passes (also non-blocking) once it settles.
  refreshJobListings()
    .catch((err: unknown) => {
      logger.error({ err }, "Initial job refresh failed");
    })
    .finally(() => {
      runAiPasses().catch((err: unknown) => {
        logger.error({ err }, "Initial AI passes failed");
      });
    });

  setInterval(() => {
    refreshJobListings()
      .catch((err: unknown) => {
        logger.error({ err }, "Scheduled job refresh failed");
      })
      .finally(() => {
        runAiPasses().catch((err: unknown) => {
          logger.error({ err }, "Post-refresh AI passes failed");
        });
      });
  }, JOB_REFRESH_INTERVAL_MS);

  // Independent 30-minute cadence so the AI passes also progress between
  // 6-hour refreshes (e.g. catching up on a backlog after startup).
  setInterval(() => {
    runAiPasses().catch((err: unknown) => {
      logger.error({ err }, "Scheduled AI passes failed");
    });
  }, TAILORING_INTERVAL_MS);
});
