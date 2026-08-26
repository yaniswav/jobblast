#!/usr/bin/env node
// Orchestrates the lot G3 E2E suite: checks the SaaS Docker stack
// (deploy/saas/compose.yaml, docs/DOCKER.md) is actually up and reachable,
// then runs the vitest specs in tests/e2e/specs against it. This script
// never brings the stack up or tears it down itself - see docs/DOCKER.md for
// that, or .github/workflows/e2e.yml for how CI does it around this same
// entry point.
//
// Invoked as `pnpm run test:e2e` from the repo root.

import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "../..");

const BASE_URL = process.env["E2E_BASE_URL"] ?? "http://localhost:8080";
const MAILPIT_URL = process.env["E2E_MAILPIT_URL"] ?? "http://localhost:8025";

async function isReachable(url) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(5_000) });
    return res.ok;
  } catch {
    return false;
  }
}

function fail(message) {
  console.error(message);
  process.exit(1);
}

async function main() {
  const appUp = await isReachable(`${BASE_URL}/api/healthz`);
  if (!appUp) {
    fail(
      `\nThe JobBlast SaaS stack is not reachable at ${BASE_URL}.\n\n` +
        "Start it first (see docs/DOCKER.md \"Build and start\"):\n\n" +
        "  cp deploy/saas/.env.docker.example deploy/saas/.env.docker   # first time only, then edit it\n" +
        "  docker compose -f deploy/saas/compose.yaml --env-file deploy/saas/.env.docker --profile dev up -d --build\n\n" +
        "The \"dev\" profile is required (not just the default `up -d`): the\n" +
        "password-reset spec reads its email through Mailpit. Wait for\n" +
        "\"docker compose ... ps\" to report db, app and caddy healthy, then\n" +
        "re-run \"pnpm run test:e2e\". Override the URL this script checks with\n" +
        "E2E_BASE_URL if your stack is not on the default localhost:8080.\n",
    );
  }

  const mailpitUp = await isReachable(`${MAILPIT_URL}/api/v1/messages`);
  if (!mailpitUp) {
    fail(
      `\nMailpit is not reachable at ${MAILPIT_URL}. The password-reset E2E\n` +
        "spec reads the reset email through it (docs/DOCKER.md \"Mailpit (local\n" +
        "email testing)\"). Bring it up alongside the rest of the stack:\n\n" +
        "  docker compose -f deploy/saas/compose.yaml --env-file deploy/saas/.env.docker --profile dev up -d\n\n" +
        "...and make sure the four JOBBLAST_SMTP_* / JOBBLAST_EMAIL_FROM lines are\n" +
        "uncommented in deploy/saas/.env.docker, then restart app:\n\n" +
        "  docker compose -f deploy/saas/compose.yaml --env-file deploy/saas/.env.docker restart app\n",
    );
  }

  // shell:true only on Windows, where pnpm is a .cmd shim that Node cannot
  // spawn directly (EINVAL without a shell, ENOENT without extension
  // resolution). Node's DEP0190 warning about unescaped args applies to
  // interpolated/untrusted input; every argument here is a static literal,
  // never derived from user input, so there is nothing for shell metacharacters
  // to act on.
  const child = spawn("pnpm", ["--filter", "@workspace/e2e", "run", "test:e2e"], {
    cwd: REPO_ROOT,
    stdio: "inherit",
    shell: process.platform === "win32",
  });
  child.on("error", (err) => fail(`Could not start the E2E test runner: ${err.message}`));
  child.on("exit", (code, signal) => {
    if (signal) fail(`E2E test runner terminated by signal ${signal}`);
    process.exit(code ?? 1);
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
