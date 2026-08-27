// Instance watches (lot H5): catalog companies fetched into the shared
// `postings` pool on every refresh cycle regardless of whether any account
// actually watches them, so the anonymous /try trial (lib/anonymous-match.ts)
// has something current to match against even right after a fresh deploy
// with zero accounts. See lib/queue/handlers.ts's `postings.instanceSeed`
// job and lib/sources/refresh.ts's fetchInstanceWatchesIntoPool().
//
// `JOBBLAST_INSTANCE_WATCHES` is a comma-separated list of catalog ids
// (lib/sources/ats/catalog.ts), e.g. "thales,airbus,safran" - documented
// with a suggested default in deploy/saas/.env.docker.example and
// docs/DOCKER.md. Saas only: selfhosted ignores it entirely, on purpose - a
// self-hoster's refresh is exactly the companies they chose to watch via
// Company Watch, nothing added on top of that.
//
// Deliberately NOT plumbed through watchedCompaniesFor()/loadConfig(): an
// instance watch belongs to no account, so it must not depend on which
// account's config happens to be ambient when the seeding job runs. Each
// ATS's per-company fetch function (fetchWorkdayCompany, fetchAshbyCompany,
// ...) already takes `board` + `label` as plain arguments and reads no
// config, which is exactly what makes fetching one company outside any
// account's context possible without threading a fake account through the
// per-user signature pipeline.

import { logger } from "../logger";
import { IS_SAAS } from "../mode";
import { COMPANY_CATALOG, type CompanyCatalogEntry } from "./ats/catalog";

/**
 * Parses `JOBBLAST_INSTANCE_WATCHES` against a catalog: unknown or
 * duplicate ids are dropped (and logged), never thrown on - a typo in an
 * env var should shrink the seed list, not crash the process. Pure, so it
 * is testable without touching `process.env` or the network.
 */
export function resolveInstanceWatches(
  raw: string | undefined,
  catalog: readonly CompanyCatalogEntry[] = COMPANY_CATALOG,
): CompanyCatalogEntry[] {
  if (!raw || !raw.trim()) return [];

  const byId = new Map(catalog.map((entry) => [entry.id, entry]));
  const seen = new Set<string>();
  const resolved: CompanyCatalogEntry[] = [];

  for (const rawId of raw.split(",")) {
    const id = rawId.trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);

    const entry = byId.get(id);
    if (!entry) {
      logger.warn({ id }, "JOBBLAST_INSTANCE_WATCHES: unknown catalog id, skipping");
      continue;
    }
    resolved.push(entry);
  }

  return resolved;
}

/** This instance's seed companies - always empty in selfhosted (see header comment). */
export function instanceWatchCompanies(): CompanyCatalogEntry[] {
  if (!IS_SAAS) return [];
  return resolveInstanceWatches(process.env["JOBBLAST_INSTANCE_WATCHES"]);
}
