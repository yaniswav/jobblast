// Greenhouse / Lever job board slugs to poll, read from
// `sources.greenhouse.boards` / `sources.lever.boards` in
// jobblast.config.json (see docs/CONFIG.md).
//
// Before adding a slug, verify it returns HTTP 200 with real postings:
//   curl -s -o /dev/null -w "%{http_code}" https://boards-api.greenhouse.io/v1/boards/<slug>/jobs
//   curl -s -o /dev/null -w "%{http_code}" https://api.lever.co/v0/postings/<slug>?mode=json
// Many guessed slugs 404, and some return 200 with an empty array. Either
// way the board silently contributes zero jobs (see greenhouse.ts /
// lever.ts error handling) while still costing request budget.

import { loadConfig, type CompanyBoardConfig } from "../config";

export type CompanyBoard = CompanyBoardConfig;

export function greenhouseBoards(): CompanyBoard[] {
  return loadConfig().sources.greenhouse.boards;
}

export function leverBoards(): CompanyBoard[] {
  return loadConfig().sources.lever.boards;
}
