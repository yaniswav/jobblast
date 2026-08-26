// Mints a real registration invite code the same way an operator would
// (docs/DOCKER.md step 3): `docker exec <app> pnpm run invite`. This is the
// only place the E2E suite shells out to Docker instead of calling the API -
// there is no HTTP endpoint for minting invites (registration is invite-only
// on purpose, docs/SAAS-ARCHITECTURE.md section 2), and scripts/src/invite.ts
// is deliberately a one-shot CLI, not a route.

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const APP_CONTAINER = process.env["E2E_APP_CONTAINER"] ?? "jobblast-saas-app";

// Crockford-ish base32 (scripts/src/invite.ts): digits plus A-Z minus I, L, O,
// U. Matched out of pnpm's own banner output rather than assuming the code is
// on a particular line, since `pnpm run invite -- ...` prints "> @workspace/
// scripts@... invite" progress lines ahead of the script's own stdout.
const CODE_PATTERN = /\b([0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4})\b/;

/** One single-use invite code, good for 1 day. `note` only ends up in the invite_codes row, for a human reading the table. */
export async function mintInviteCode(note: string): Promise<string> {
  let stdout: string;
  try {
    ({ stdout } = await execFileAsync("docker", [
      "exec",
      APP_CONTAINER,
      "pnpm",
      "run",
      "invite",
      "--",
      "--uses",
      "1",
      "--days",
      "1",
      "--note",
      `e2e:${note}`,
    ]));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(
      `Could not mint an invite code via "docker exec ${APP_CONTAINER} pnpm run invite". ` +
        `Is the SaaS stack up (docs/DOCKER.md)? Underlying error: ${message}`,
    );
  }

  const match = CODE_PATTERN.exec(stdout);
  if (!match?.[1]) {
    throw new Error(`"docker exec ${APP_CONTAINER} pnpm run invite" did not print an invite code:\n${stdout}`);
  }
  return match[1];
}
