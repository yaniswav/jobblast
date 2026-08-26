// Greenhouse / Lever job board slugs to poll: the union of two lists.
//
//   1. `sources.greenhouse.boards` / `sources.lever.boards` in
//      jobblast.config.json - a hand-curated shortlist (see docs/CONFIG.md).
//   2. `watchedCompanies` entries an account added via Company Watch
//      (POST /settings/companies, lib/sources/ats/) whose detected ATS is
//      "greenhouse" or "lever". These reuse the exact same fetcher
//      (greenhouse.ts / lever.ts) rather than a separate code path.
//
// Before adding a slug by hand, verify it returns HTTP 200 with real postings:
//   curl -s -o /dev/null -w "%{http_code}" https://boards-api.greenhouse.io/v1/boards/<slug>/jobs
//   curl -s -o /dev/null -w "%{http_code}" https://api.lever.co/v0/postings/<slug>?mode=json
// Many guessed slugs 404, and some return 200 with an empty array. Either
// way the board silently contributes zero jobs (see greenhouse.ts /
// lever.ts error handling) while still costing request budget.

import { loadConfig, type AtsId, type CompanyBoardConfig, type WatchedCompanyConfig } from "../config";

export type CompanyBoard = CompanyBoardConfig;

/**
 * Merges the hand-curated board list with watched companies for one ATS,
 * de-duplicated by slug (a hand-curated entry wins its `name` on a
 * collision). Pure, and used both here (against the ambient account) and by
 * signature.ts's sourceQueries() (against an explicit config), so the two
 * never disagree about what a fetch actually covers.
 */
export function mergeCompanyBoards(
  configured: readonly CompanyBoard[],
  ats: AtsId,
  watched: readonly WatchedCompanyConfig[],
): CompanyBoard[] {
  const bySlug = new Map<string, CompanyBoard>();
  for (const board of configured) bySlug.set(board.slug, board);
  for (const company of watched) {
    if (company.ats !== ats) continue;
    if (!bySlug.has(company.board)) bySlug.set(company.board, { slug: company.board, name: company.label });
  }
  return Array.from(bySlug.values());
}

export function greenhouseBoards(): CompanyBoard[] {
  const cfg = loadConfig();
  return mergeCompanyBoards(cfg.sources.greenhouse.boards, "greenhouse", cfg.watchedCompanies);
}

export function leverBoards(): CompanyBoard[] {
  const cfg = loadConfig();
  return mergeCompanyBoards(cfg.sources.lever.boards, "lever", cfg.watchedCompanies);
}

/** This account's watched companies for one of the six new Company Watch ATSs. */
export function watchedCompaniesFor(ats: AtsId): WatchedCompanyConfig[] {
  return loadConfig().watchedCompanies.filter((company) => company.ats === ats);
}
