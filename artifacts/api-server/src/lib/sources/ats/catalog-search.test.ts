// searchCompanyCatalog / foldForSearch (lot H5). Uses a small fixture
// catalog rather than the real COMPANY_CATALOG so ranking assertions do not
// depend on which real companies happen to be in it - see catalog.test.ts
// for the real catalog's own integrity.

import { describe, expect, it } from "vitest";
import type { CompanyCatalogEntry } from "./catalog";
import { foldForSearch, searchCompanyCatalog } from "./catalog-search";

const FIXTURE: CompanyCatalogEntry[] = [
  { id: "thales", label: "Thales", sector: "Aerospace & Defense", ats: "workday", board: "b1", careerUrl: "https://a" },
  { id: "alten", label: "Alten", sector: "Engineering Consulting", ats: "smartrecruiters", board: "b2", careerUrl: "https://b" },
  { id: "assystem", label: "Assystem", sector: "Engineering Consulting", ats: "smartrecruiters", board: "b3", careerUrl: "https://c" },
  { id: "doctolib", label: "Doctolib", sector: "Healthtech", ats: "greenhouse", board: "b4", careerUrl: "https://d" },
  { id: "airbnb", label: "Airbnb", sector: "Travel & Hospitality", ats: "greenhouse", board: "b5", careerUrl: "https://e" },
];

describe("foldForSearch", () => {
  it("lowercases and strips diacritics", () => {
    expect(foldForSearch("Thalès")).toBe("thales");
    expect(foldForSearch("  ÉLECTRIQUE  ")).toBe("electrique");
  });
});

describe("searchCompanyCatalog", () => {
  it("is case- and accent-insensitive", () => {
    expect(searchCompanyCatalog("thales", 10, FIXTURE).map((e) => e.id)).toEqual(["thales"]);
    expect(searchCompanyCatalog("THALES", 10, FIXTURE).map((e) => e.id)).toEqual(["thales"]);
    expect(searchCompanyCatalog("thàlés", 10, FIXTURE).map((e) => e.id)).toEqual(["thales"]);
  });

  it("returns nothing for an empty or whitespace-only query", () => {
    expect(searchCompanyCatalog("", 10, FIXTURE)).toEqual([]);
    expect(searchCompanyCatalog("   ", 10, FIXTURE)).toEqual([]);
  });

  it("matches on sector as well as label", () => {
    const results = searchCompanyCatalog("engineering", 10, FIXTURE);
    expect(results.map((e) => e.id).sort()).toEqual(["alten", "assystem"]);
  });

  it("ranks a label prefix match above a mid-word or sector match", () => {
    // "al" is a prefix of Alten's label and a mid-word match nowhere else in
    // the fixture, so it alone should lead.
    const results = searchCompanyCatalog("al", 10, FIXTURE);
    expect(results[0]?.id).toBe("alten");
  });

  it("breaks ties alphabetically by label", () => {
    // Both Alten and Assystem's sector starts with "engineering" - same
    // rank, alphabetical order decides.
    const results = searchCompanyCatalog("engineering consulting", 10, FIXTURE);
    expect(results.map((e) => e.id)).toEqual(["alten", "assystem"]);
  });

  it("respects the limit", () => {
    const results = searchCompanyCatalog("a", 2, FIXTURE);
    expect(results.length).toBe(2);
  });

  it("defaults to a limit of 10 against the real catalog shape", () => {
    const bigCatalog: CompanyCatalogEntry[] = Array.from({ length: 15 }, (_, i) => ({
      id: `acme-${i}`,
      label: `Acme ${i}`,
      sector: "Software",
      ats: "greenhouse" as const,
      board: `acme-${i}`,
      careerUrl: `https://boards.greenhouse.io/acme-${i}`,
    }));
    expect(searchCompanyCatalog("acme", undefined, bigCatalog).length).toBe(10);
  });
});
