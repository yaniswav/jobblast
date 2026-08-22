import app from "./app";
import { runTailoringPass } from "./lib/ai/tailor";
import { logger } from "./lib/logger";
import { refreshJobListings } from "./lib/sources/refresh";

const JOB_REFRESH_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6 hours
const TAILORING_INTERVAL_MS = 30 * 60 * 1000; // 30 minutes
const TAILORING_BATCH_SIZE = 10;

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

  // Populate/refresh real job listings without blocking server startup, then
  // kick off an AI tailoring pass (also non-blocking) once it settles.
  refreshJobListings()
    .catch((err: unknown) => {
      logger.error({ err }, "Initial job refresh failed");
    })
    .finally(() => {
      runTailoringPass(TAILORING_BATCH_SIZE).catch((err: unknown) => {
        logger.error({ err }, "Initial AI tailoring pass failed");
      });
    });

  setInterval(() => {
    refreshJobListings()
      .catch((err: unknown) => {
        logger.error({ err }, "Scheduled job refresh failed");
      })
      .finally(() => {
        runTailoringPass(TAILORING_BATCH_SIZE).catch((err: unknown) => {
          logger.error({ err }, "Post-refresh AI tailoring pass failed");
        });
      });
  }, JOB_REFRESH_INTERVAL_MS);

  // Independent 30-minute cadence so tailoring also progresses between
  // 6-hour refreshes (e.g. catching up on a backlog after startup).
  setInterval(() => {
    runTailoringPass(TAILORING_BATCH_SIZE).catch((err: unknown) => {
      logger.error({ err }, "Scheduled AI tailoring pass failed");
    });
  }, TAILORING_INTERVAL_MS);
});
