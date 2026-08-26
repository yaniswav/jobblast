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
 * Pure so the preflight is testable without touching process.env.
 */
export function missingSaasEnv(
  mode: JobBlastMode,
  env: Record<string, string | undefined>,
): string[] {
  if (mode !== "saas") return [];
  // Kept to what lot B actually uses. JOBBLAST_MASTER_KEY (BYOK) and the
  // SMTP group (password reset) join this list when those lots land.
  return ["APP_ORIGIN"].filter((name) => !env[name]?.trim());
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
}

/** Origin the browser app is served from, used by the CSRF check. */
export function appOrigin(): string | null {
  const raw = process.env["APP_ORIGIN"]?.trim();
  return raw ? raw.replace(/\/+$/, "") : null;
}
