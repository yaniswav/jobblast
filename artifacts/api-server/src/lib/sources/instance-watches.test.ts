// Instance watches (lot H5). resolveInstanceWatches is pure - tested here
// against a small fixture catalog rather than the real COMPANY_CATALOG, so
// these assertions do not depend on which real companies happen to be in it.

import { describe, expect, it } from "vitest";
import type { CompanyCatalogEntry } from "./ats/catalog";
import { instanceWatchCompanies, resolveInstanceWatches } from "./instance-watches";

const FIXTURE: CompanyCatalogEntry[] = [
  { id: "thales", label: "Thales", sector: "Aerospace & Defense", ats: "workday", board: "b1", careerUrl: "https://a" },
  { id: "airbus", label: "Airbus", sector: "Aerospace & Defense", ats: "workday", board: "b2", careerUrl: "https://b" },
  { id: "safran", label: "Safran", sector: "Aerospace & Defense", ats: "workday", board: "b3", careerUrl: "https://c" },
];

describe("resolveInstanceWatches", () => {
  it("returns nothing for an unset or blank env var", () => {
    expect(resolveInstanceWatches(undefined, FIXTURE)).toEqual([]);
    expect(resolveInstanceWatches("", FIXTURE)).toEqual([]);
    expect(resolveInstanceWatches("   ", FIXTURE)).toEqual([]);
  });

  it("resolves a comma-separated list of known ids, trimming whitespace", () => {
    const resolved = resolveInstanceWatches(" thales, airbus ,safran", FIXTURE);
    expect(resolved.map((e) => e.id)).toEqual(["thales", "airbus", "safran"]);
  });

  it("drops unknown ids instead of throwing", () => {
    const resolved = resolveInstanceWatches("thales,not-a-real-company,airbus", FIXTURE);
    expect(resolved.map((e) => e.id)).toEqual(["thales", "airbus"]);
  });

  it("drops duplicate ids, keeping the first occurrence", () => {
    const resolved = resolveInstanceWatches("thales,airbus,thales", FIXTURE);
    expect(resolved.map((e) => e.id)).toEqual(["thales", "airbus"]);
  });

  it("skips empty segments from stray commas", () => {
    const resolved = resolveInstanceWatches("thales,,airbus,", FIXTURE);
    expect(resolved.map((e) => e.id)).toEqual(["thales", "airbus"]);
  });
});

describe("instanceWatchCompanies", () => {
  // The unit test process never sets JOBBLAST_MODE=saas, so IS_SAAS is false
  // here the same way it is for a real selfhosted install - this is the
  // "ignored entirely in selfhosted" contract exercised for real, not mocked.
  it("is empty in selfhosted regardless of JOBBLAST_INSTANCE_WATCHES", () => {
    const previous = process.env["JOBBLAST_INSTANCE_WATCHES"];
    process.env["JOBBLAST_INSTANCE_WATCHES"] = "thales,airbus";
    try {
      expect(instanceWatchCompanies()).toEqual([]);
    } finally {
      if (previous === undefined) delete process.env["JOBBLAST_INSTANCE_WATCHES"];
      else process.env["JOBBLAST_INSTANCE_WATCHES"] = previous;
    }
  });
});
