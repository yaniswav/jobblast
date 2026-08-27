// Pure fixture tests for the keyword-targeting logic lot J3 added: capping
// the follower keyword list (targetKeywords) and merging a company's
// targeted + untargeted listing results (mergeTargetedFirst). See
// keyword-search.ts's header for why this exists - Workday's untargeted
// first page on a 2000+-posting employer like Thales is almost entirely
// irrelevant, so workday.ts / smartrecruiters.ts run one search per follower
// keyword on top of it and rely on this file's logic to cap, dedup and
// prioritize the result.

import { describe, expect, it } from "vitest";
import { MAX_KEYWORDS_PER_COMPANY } from "./limits";
import { mergeTargetedFirst, targetKeywords } from "./keyword-search";

describe("targetKeywords", () => {
  it("trims whitespace and drops empty entries", () => {
    expect(targetKeywords([" c++ ", "", "   ", "embedded"])).toEqual(["c++", "embedded"]);
  });

  it("de-duplicates case-insensitively, keeping the first spelling", () => {
    expect(targetKeywords(["C++", "c++", "Embedded", "embedded"])).toEqual(["C++", "Embedded"]);
  });

  it("caps the list at MAX_KEYWORDS_PER_COMPANY", () => {
    const many = Array.from({ length: MAX_KEYWORDS_PER_COMPANY + 10 }, (_, i) => `kw${i}`);
    const result = targetKeywords(many);
    expect(result).toHaveLength(MAX_KEYWORDS_PER_COMPANY);
    expect(result).toEqual(many.slice(0, MAX_KEYWORDS_PER_COMPANY));
  });

  it("returns an empty list for an empty or all-blank input", () => {
    expect(targetKeywords([])).toEqual([]);
    expect(targetKeywords(["   ", ""])).toEqual([]);
  });
});

type Fixture = { id: string; title: string };

describe("mergeTargetedFirst", () => {
  const byId = (item: Fixture) => item.id;

  it("orders targeted results before untargeted ones", () => {
    const targeted: Fixture[] = [{ id: "t1", title: "C++ Engineer" }];
    const untargeted: Fixture[] = [{ id: "u1", title: "Sales Manager" }];
    expect(mergeTargetedFirst(targeted, untargeted, byId).map((item) => item.id)).toEqual(["t1", "u1"]);
  });

  it("deduplicates by key, keeping the targeted (first) occurrence", () => {
    const targeted: Fixture[] = [{ id: "shared", title: "From the targeted search" }];
    const untargeted: Fixture[] = [{ id: "shared", title: "From the general page" }];
    const merged = mergeTargetedFirst(targeted, untargeted, byId);
    expect(merged).toHaveLength(1);
    expect(merged[0]?.title).toBe("From the targeted search");
  });

  it("deduplicates within the targeted results themselves (two keywords, same posting)", () => {
    const targeted: Fixture[] = [
      { id: "R1", title: "Ingénieur C++" },
      { id: "R1", title: "Ingénieur C++" },
      { id: "R2", title: "Ingénieur Embarqué" },
    ];
    const merged = mergeTargetedFirst(targeted, [], byId);
    expect(merged.map((item) => item.id)).toEqual(["R1", "R2"]);
  });

  it("preserves both lists' relative order", () => {
    const targeted: Fixture[] = [
      { id: "t1", title: "first keyword hit" },
      { id: "t2", title: "second keyword hit" },
    ];
    const untargeted: Fixture[] = [
      { id: "u1", title: "general page 1" },
      { id: "u2", title: "general page 2" },
    ];
    expect(mergeTargetedFirst(targeted, untargeted, byId).map((item) => item.id)).toEqual([
      "t1",
      "t2",
      "u1",
      "u2",
    ]);
  });
});
