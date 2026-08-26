// Contract-type request construction (lot H3), the pure function this
// fetcher's request fan-out depends on. Every case here was cross-checked
// against a live call to the real API (see francetravail.ts's header
// comment and the lot H3 report): typeContrat takes comma-separated codes,
// alternance is a separate natureContrat axis that can't share a request
// with typeContrat, and "stage" has no code anywhere in the API.

import { describe, expect, it } from "vitest";
import { franceTravailRequestGroups } from "./francetravail";

describe("franceTravailRequestGroups", () => {
  it("sends no contract-type filter at all when the list is empty (today's unchanged default)", () => {
    expect(franceTravailRequestGroups([])).toEqual([{}]);
  });

  it("maps a single ordinary type to one typeContrat request", () => {
    expect(franceTravailRequestGroups(["cdi"])).toEqual([{ typeContrat: "CDI" }]);
    expect(franceTravailRequestGroups(["cdd"])).toEqual([{ typeContrat: "CDD" }]);
    expect(franceTravailRequestGroups(["interim"])).toEqual([{ typeContrat: "MIS" }]);
  });

  it("comma-joins several ordinary types into one request", () => {
    expect(franceTravailRequestGroups(["cdi", "cdd", "interim"])).toEqual([
      { typeContrat: "CDI,CDD,MIS" },
    ]);
  });

  it("maps alternance to a separate natureContrat request, not typeContrat", () => {
    expect(franceTravailRequestGroups(["alternance"])).toEqual([{ natureContrat: "E2,FS" }]);
  });

  it("splits an ordinary type plus alternance into two requests (the API ANDs one request's params)", () => {
    const groups = franceTravailRequestGroups(["cdi", "alternance"]);
    expect(groups).toHaveLength(2);
    expect(groups).toContainEqual({ typeContrat: "CDI" });
    expect(groups).toContainEqual({ natureContrat: "E2,FS" });
  });

  it("contributes zero requests when only stage is selected - France Travail has no internship code", () => {
    expect(franceTravailRequestGroups(["stage"])).toEqual([]);
  });

  it("drops stage but keeps whatever else was selected alongside it", () => {
    expect(franceTravailRequestGroups(["stage", "cdi"])).toEqual([{ typeContrat: "CDI" }]);
  });
});
