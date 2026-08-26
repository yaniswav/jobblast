// The one environment variable that decides which product this process is.
//
//   selfhosted (default) - single implicit user, no login screen, config in
//                          jobblast.config.json, CLI-backed features on.
//   saas                 - email + password accounts, config per account in
//                          the database, CLI-backed features off.
//
// Read once, checked in as few places as possible: the auth middleware, the
// config-store backend selection and this file's startup preflight. Route
// handlers never branch on it.
//
// An unset variable, a typo or an old .env all resolve to `selfhosted`, so
// an existing install can never wake up as a multi-tenant server by
// accident.

import { masterKeyFormatError } from "./crypto/byok";

export type JobBlastMode = "selfhosted" | "saas";

/** Pure resolver, so the "never `saas` by accident" rule is testable. */
export function resolveMode(raw: string | undefined): JobBlastMode {
  return raw?.trim().toLowerCase() === "saas" ? "saas" : "selfhosted";
}

export const MODE: JobBlastMode = resolveMode(process.env["JOBBLAST_MODE"]);
export const IS_SAAS = MODE === "saas";

/**
 * Variables `saas` refuses to boot without, in the same fail-fast spirit as
 * loadConfig(). `selfhosted` requires none of them and returns an empty list.
 *
 * Pure so the preflight is testable without touching process.env. Presence
 * only: JOBBLAST_MASTER_KEY's *format* (32 bytes base64) is checked
 * separately in runStartupPreflight, via lib/crypto/byok.ts, so this stays a
 * simple existence check and the BYOK-specific validation stays in one
 * place. The SMTP group (password reset) joins this list when that lot
 * lands.
 */
export function missingSaasEnv(
  mode: JobBlastMode,
  env: Record<string, string | undefined>,
): string[] {
  if (mode !== "saas") return [];
  return ["APP_ORIGIN", "JOBBLAST_MASTER_KEY"].filter((name) => !env[name]?.trim());
}

/** Throws with an actionable message when `saas` is missing its configuration. */
export function runStartupPreflight(): void {
  const missing = missingSaasEnv(MODE, process.env);
  if (missing.length > 0) {
    throw new Error(
      `JOBBLAST_MODE=saas requires ${missing.join(", ")} to be set. ` +
        "See the \"SaaS mode only\" block in .env.example.",
    );
  }

  if (MODE === "saas") {
    // Presence was just checked above; this catches a JOBBLAST_MASTER_KEY
    // that is set but malformed (wrong length, not base64) - fail closed
    // rather than let the BYOK crypto layer discover it lazily on the first
    // request that needs it.
    const problem = masterKeyFormatError(process.env["JOBBLAST_MASTER_KEY"]);
    if (problem) {
      throw new Error(`JOBBLAST_MODE=saas: ${problem}`);
    }
  }
}

/** Origin the browser app is served from, used by the CSRF check. */
export function appOrigin(): string | null {
  const raw = process.env["APP_ORIGIN"]?.trim();
  return raw ? raw.replace(/\/+$/, "") : null;
}
