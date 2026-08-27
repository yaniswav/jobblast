// Company Watch "type a name" search (lot H5): GET /companies/catalog?q=
// matches free text against COMPANY_CATALOG's label and sector, case- and
// accent-insensitive ("thal" and "THAL" and "thál" all find "Thales"),
// ranked so a name match beats a sector-only match and a prefix match beats
// a mid-word one. Pure, no network - the catalog itself is a static list.

import { COMPANY_CATALOG, type CompanyCatalogEntry } from "./catalog";

const DEFAULT_LIMIT = 10;

/** Lowercases and strips diacritics, so "é"/"e" and "Thalès"/"thales" compare equal. */
export function foldForSearch(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "") // combining diacritical marks left behind by NFD
    .toLowerCase()
    .trim();
}

/** Lower = better match. null = no match at all. */
function rank(entry: CompanyCatalogEntry, foldedQuery: string): number | null {
  const label = foldForSearch(entry.label);
  const sector = foldForSearch(entry.sector);
  if (label.startsWith(foldedQuery)) return 0;
  if (label.includes(foldedQuery)) return 1;
  if (sector.startsWith(foldedQuery)) return 2;
  if (sector.includes(foldedQuery)) return 3;
  return null;
}

/**
 * Matches `query` against the catalog, best match first, at most `limit`
 * results. An empty (or whitespace-only) query returns nothing - the UI only
 * opens this dropdown once the visitor has actually typed something.
 */
export function searchCompanyCatalog(
  query: string,
  limit = DEFAULT_LIMIT,
  catalog: readonly CompanyCatalogEntry[] = COMPANY_CATALOG,
): CompanyCatalogEntry[] {
  const folded = foldForSearch(query);
  if (!folded) return [];

  return catalog
    .map((entry) => ({ entry, rank: rank(entry, folded) }))
    .filter((scored): scored is { entry: CompanyCatalogEntry; rank: number } => scored.rank !== null)
    .sort((a, b) => a.rank - b.rank || a.entry.label.localeCompare(b.entry.label))
    .slice(0, limit)
    .map((scored) => scored.entry);
}
