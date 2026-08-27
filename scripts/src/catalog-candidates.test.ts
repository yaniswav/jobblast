// Pure-logic tests for catalog-candidates.ts's aggregation/diff (lot H6). No
// database, no filesystem, no network - the report's actual account reads
// live in watchedCompaniesFromDatabase()/watchedCompaniesFromFile(), which
// this file does not exercise; only the pure boundary below it.

import { describe, expect, it } from "vitest";
import {
  diffCatalogCandidates,
  parseCatalogKeys,
  parseWatchedCompanies,
  type WatchedCompanyRecord,
} from "./catalog-candidates";

describe("diffCatalogCandidates", () => {
  const catalogKeys = new Set(["greenhouse:airbnb", "lever:qonto"]);

  it("drops companies already in the catalog", () => {
    const watched: WatchedCompanyRecord[] = [
      { ats: "greenhouse", board: "airbnb", url: "https://boards.greenhouse.io/airbnb", label: "Airbnb" },
    ];
    expect(diffCatalogCandidates(watched, catalogKeys)).toEqual([]);
  });

  it("lists a watched company that is not yet in the catalog, with a follower count", () => {
    const watched: WatchedCompanyRecord[] = [
      { ats: "greenhouse", board: "acme", url: "https://boards.greenhouse.io/acme", label: "Acme" },
    ];
    expect(diffCatalogCandidates(watched, catalogKeys)).toEqual([
      { ats: "greenhouse", board: "acme", url: "https://boards.greenhouse.io/acme", label: "Acme", followerCount: 1 },
    ]);
  });

  it("aggregates the same company followed by several accounts into one row", () => {
    const watched: WatchedCompanyRecord[] = [
      { ats: "lever", board: "foo", url: "https://jobs.lever.co/foo", label: "Foo Inc" },
      { ats: "lever", board: "foo", url: "https://jobs.lever.co/foo", label: "Foo Inc" },
      { ats: "lever", board: "foo", url: "https://jobs.lever.co/foo", label: "Foo Inc" },
    ];
    const result = diffCatalogCandidates(watched, catalogKeys);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ ats: "lever", board: "foo", followerCount: 3 });
  });

  it("never includes an account identifier - the record shape has none to leak", () => {
    const watched: WatchedCompanyRecord[] = [
      { ats: "ashby", board: "beta", url: "https://jobs.ashbyhq.com/beta", label: "Beta Co" },
    ];
    const [candidate] = diffCatalogCandidates(watched, catalogKeys);
    expect(Object.keys(candidate!)).toEqual(["ats", "board", "url", "label", "followerCount"]);
  });

  it("sorts by follower count descending, ties broken alphabetically by label", () => {
    const watched: WatchedCompanyRecord[] = [
      { ats: "ashby", board: "zeta", url: "https://jobs.ashbyhq.com/zeta", label: "Zeta" },
      { ats: "ashby", board: "alpha", url: "https://jobs.ashbyhq.com/alpha", label: "Alpha" },
      { ats: "ashby", board: "beta", url: "https://jobs.ashbyhq.com/beta", label: "Beta" },
      { ats: "ashby", board: "beta", url: "https://jobs.ashbyhq.com/beta", label: "Beta" },
    ];
    const result = diffCatalogCandidates(watched, catalogKeys);
    expect(result.map((c) => c.label)).toEqual(["Beta", "Alpha", "Zeta"]);
  });

  it("returns nothing for an empty input", () => {
    expect(diffCatalogCandidates([], catalogKeys)).toEqual([]);
  });
});

describe("parseCatalogKeys", () => {
  it("extracts ats:board pairs from catalog-entry-shaped source text", () => {
    const source = `
      export const COMPANY_CATALOG = [
        { id: "airbnb", label: "Airbnb", sector: "Travel", ats: "greenhouse", board: "airbnb", careerUrl: "https://boards.greenhouse.io/airbnb" },
        { id: "qonto", label: "Qonto", sector: "Fintech", ats: "lever", board: "qonto", careerUrl: "https://jobs.lever.co/qonto" },
      ];
    `;
    expect(parseCatalogKeys(source)).toEqual(new Set(["greenhouse:airbnb", "lever:qonto"]));
  });

  it("ignores a type alias block with no quoted ats/board values", () => {
    const source = `export type CompanyCatalogEntry = { id: string; label: string; ats: AtsId; board: string; };`;
    expect(parseCatalogKeys(source)).toEqual(new Set());
  });

  it("returns an empty set for source with no entries", () => {
    expect(parseCatalogKeys("")).toEqual(new Set());
  });
});

describe("parseWatchedCompanies", () => {
  it("keeps well-formed entries", () => {
    const value = [{ id: "x", ats: "greenhouse", board: "acme", url: "https://boards.greenhouse.io/acme", label: "Acme", addedAt: "2026-01-01" }];
    expect(parseWatchedCompanies(value)).toEqual([
      { ats: "greenhouse", board: "acme", url: "https://boards.greenhouse.io/acme", label: "Acme" },
    ]);
  });

  it("drops a malformed entry instead of throwing", () => {
    const value = [{ ats: "greenhouse" }, "not an object", 42, null];
    expect(parseWatchedCompanies(value)).toEqual([]);
  });

  it("returns an empty array for non-array input (missing/malformed config)", () => {
    expect(parseWatchedCompanies(undefined)).toEqual([]);
    expect(parseWatchedCompanies(null)).toEqual([]);
    expect(parseWatchedCompanies({})).toEqual([]);
  });
});
