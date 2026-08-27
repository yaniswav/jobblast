// Shared "search each watched company with the followers' own keywords"
// helpers (lot J3). The problem this fixes: Thales alone runs ~2000 open
// postings on Workday, and the untargeted listing call
// (`{"searchText":""}`) returns whatever page Workday's default ordering
// puts first - verified live, almost none of it C++. Workday's own search
// box (`searchText`) and SmartRecruiters' public API (`?q=`, verified live
// against Grab: `?q=engineer` narrows Grab's 400 postings to 207, a nonsense
// query returns 0) both let a fetch ask for what a follower is actually
// looking for, so this module pairs one untargeted page (general coverage -
// still worth keeping, since a posting can be relevant without containing
// any exact keyword) with one targeted search per follower keyword.
//
// This file is the pure, source-agnostic half of that: normalizing the
// keyword list (workday.ts / smartrecruiters.ts each do the ATS-specific
// pagination around a `searchText`/`q` value) and merging the targeted +
// untargeted results back into one deduplicated, priority-ordered list, so
// both have a fixture test instead of only being exercised through a live
// fetch.
//
// "The followers' keywords", concretely: `sources.franceTravail.keywords`
// (lib/config-store.ts's `searchCriteria.keywords`, the field the Settings
// page's search-criteria form edits) - selfhosted has one account, so that
// is directly "this account's keywords". lib/sources/signature.ts now folds
// the same list into the Workday/SmartRecruiters query signature, so in
// `saas` every account sharing one fetch (lib/queue/handlers.ts's
// `runRefresh`, "fetch under the first subscriber's configuration") is, by
// construction, asking with the identical keyword list - two accounts
// watching the same boards with different keywords are two different
// signatures (two separate fetches), the same compromise
// lib/sources/companies.ts already makes for the board list itself.

import { MAX_KEYWORDS_PER_COMPANY } from "./limits";

/**
 * Normalizes an account's free-text search keywords into what a targeted
 * fetch actually searches with: trimmed, empty entries dropped,
 * de-duplicated case-insensitively (first spelling wins, matching
 * signature.ts's own canonicalize()), capped to MAX_KEYWORDS_PER_COMPANY so
 * a long keyword list cannot turn one watched company into an unbounded
 * number of extra requests on its own.
 */
export function targetKeywords(rawKeywords: readonly string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const raw of rawKeywords) {
    const trimmed = raw.trim();
    if (!trimmed) continue;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(trimmed);
    if (result.length >= MAX_KEYWORDS_PER_COMPANY) break;
  }
  return result;
}

/**
 * Combines one company's targeted (per-keyword) and untargeted (general
 * coverage) listing results into one deduplicated list, targeted results
 * first - so a caller that only sends the expensive per-posting detail call
 * to the first N entries (MAX_DETAIL_FETCHES_PER_COMPANY) spends that budget
 * on what the followers actually searched for before the generic first
 * page. `keyOf` is the adapter's own notion of identity (Workday's
 * `externalPath`, SmartRecruiters' `id`) - first occurrence wins, the same
 * "already have it" rule lib/sources/refresh.ts's own dedup passes use.
 */
export function mergeTargetedFirst<T>(
  targeted: readonly T[],
  untargeted: readonly T[],
  keyOf: (item: T) => string,
): T[] {
  const seen = new Set<string>();
  const merged: T[] = [];
  for (const item of [...targeted, ...untargeted]) {
    const key = keyOf(item);
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(item);
  }
  return merged;
}
