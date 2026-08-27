// Pure helpers for GET /explore (lot J2: search the entire shared pool
// directly, beyond whatever an account's own criteria have already scored
// and queued). No database, no Express - the route (routes/explore.ts)
// validates raw query-string input through these, then hands the result to
// lib/repo/postings.ts's searchPostings(); this file also shapes one pool
// row into the card the UI renders.
//
// Accent folding, documented limitation: this app has no guarantee an
// `unaccent` Postgres extension is available (a self-hosted install runs
// whatever Postgres it has), so the stored title/company/description text is
// never itself accent-folded - ILIKE only folds case, never diacritics.
// What this module CAN do cheaply is fold the *query*, and have the repo
// layer ILIKE against both the raw query and its folded form. That only
// helps one direction: typing an accented query ("développeur") also tries
// its unaccented spelling ("developpeur"), so it still finds a listing an
// English-first board spelled without the accent. It does NOT help the
// opposite and, in practice, more common direction - typing an unaccented
// query ("developpeur") does not find a listing spelled "Développeur",
// because folding an already-unaccented query changes nothing, and ILIKE
// itself never strips accents from the stored text. Confirmed empirically
// against the real pool, not merely theoretical. Full two-way folding needs
// `unaccent()` applied to the stored columns in the WHERE clause, which
// needs the extension enabled - out of scope for this lot (see
// lib/repo/postings.ts's searchPostings for where that would go).

import { foldForSearch } from "./sources/ats/catalog-search";
import { excerpt } from "./text-excerpt";

/** `q` shorter than this (after trimming) is rejected - too short to be a
 * meaningful search and too expensive to run as a pool-wide ILIKE. */
export const MIN_QUERY_LENGTH = 2;
/** Hard cap on results per page, whatever the caller asks for - keeps a
 * search a bounded, indexed query rather than an open-ended scan. */
export const MAX_LIMIT = 25;
/** Results per page when the caller does not specify one. */
export const DEFAULT_LIMIT = 20;
/** How long a card's description excerpt is, in characters. */
export const DESCRIPTION_EXCERPT_LENGTH = 300;

/** Whether `q` (as typed, before trimming) is long enough to search on. */
export function isValidExploreQuery(q: string): boolean {
  return q.trim().length >= MIN_QUERY_LENGTH;
}

/** Clamps a raw `limit` into [1, MAX_LIMIT]; anything missing, non-finite or
 * non-positive falls back to DEFAULT_LIMIT. */
export function clampExploreLimit(raw: number | undefined): number {
  if (raw === undefined || !Number.isFinite(raw) || raw <= 0) return DEFAULT_LIMIT;
  return Math.min(MAX_LIMIT, Math.trunc(raw));
}

/** Floors a raw `offset` at 0; anything missing or non-finite becomes 0. */
export function clampExploreOffset(raw: number | undefined): number {
  if (raw === undefined || !Number.isFinite(raw) || raw <= 0) return 0;
  return Math.trunc(raw);
}

export type ExploreSearchInput = {
  q: string;
  location?: string;
  source?: string;
  limit?: number;
  offset?: number;
};

/** What the repo layer's searchPostings() needs, already trimmed and
 * bounded - never re-validated once built. */
export type ExploreSearchParams = {
  q: string;
  foldedQ: string;
  location: string | null;
  source: string | null;
  limit: number;
  offset: number;
};

/** Validates and normalizes raw (query-string) input. Null means "q is
 * missing or too short" - the route answers 400 without ever reaching the
 * database. */
export function parseExploreSearch(input: ExploreSearchInput): ExploreSearchParams | null {
  const q = input.q.trim();
  if (q.length < MIN_QUERY_LENGTH) return null;

  const location = input.location?.trim();
  const source = input.source?.trim();
  return {
    q,
    foldedQ: foldForSearch(q),
    location: location ? location : null,
    source: source ? source : null,
    limit: clampExploreLimit(input.limit),
    offset: clampExploreOffset(input.offset),
  };
}

/** One pool row, exactly what lib/repo/postings.ts's searchPostings() reads
 * plus the per-account `inMyQueue` flag it computes via its join. */
export type ExplorePostingRow = {
  id: number;
  source: string;
  title: string;
  company: string;
  location: string;
  workMode: string;
  description: string;
  postedDate: string;
  url: string;
  inMyQueue: boolean;
};

/** One card as GET /explore returns it (ExplorePosting in openapi.yaml):
 * same row, with `description` replaced by a stripped, truncated excerpt. */
export type ExplorePostingCard = Omit<ExplorePostingRow, "description"> & {
  descriptionExcerpt: string;
};

/** Shapes one pool row into the card the UI renders. */
export function toExplorePostingCard(row: ExplorePostingRow): ExplorePostingCard {
  const { description, ...rest } = row;
  return { ...rest, descriptionExcerpt: excerpt(description, DESCRIPTION_EXCERPT_LENGTH) };
}
