// Pure-logic tests for GET /explore's request-shaping helpers (lot J2). No
// DOM, no database, no Express - parseExploreSearch/clamp*/toExplorePostingCard
// are plain functions, exercised directly.

import { describe, expect, it } from "vitest";
import {
  clampExploreLimit,
  clampExploreOffset,
  DEFAULT_LIMIT,
  DESCRIPTION_EXCERPT_LENGTH,
  isValidExploreQuery,
  MAX_LIMIT,
  MIN_QUERY_LENGTH,
  parseExploreSearch,
  toExplorePostingCard,
  type ExplorePostingRow,
} from "./explore-search";

describe("isValidExploreQuery", () => {
  it("rejects anything shorter than MIN_QUERY_LENGTH once trimmed", () => {
    expect(isValidExploreQuery("")).toBe(false);
    expect(isValidExploreQuery("c")).toBe(false);
    expect(isValidExploreQuery("  c  ")).toBe(false);
  });

  it("accepts a query at or above the minimum", () => {
    expect(MIN_QUERY_LENGTH).toBe(2);
    expect(isValidExploreQuery("c++")).toBe(true);
    expect(isValidExploreQuery("  ok  ")).toBe(true);
  });
});

describe("clampExploreLimit", () => {
  it("defaults when missing, zero, negative or non-finite", () => {
    expect(clampExploreLimit(undefined)).toBe(DEFAULT_LIMIT);
    expect(clampExploreLimit(0)).toBe(DEFAULT_LIMIT);
    expect(clampExploreLimit(-5)).toBe(DEFAULT_LIMIT);
    expect(clampExploreLimit(Number.NaN)).toBe(DEFAULT_LIMIT);
  });

  it("caps at MAX_LIMIT however high the caller asks", () => {
    expect(MAX_LIMIT).toBe(25);
    expect(clampExploreLimit(1000)).toBe(25);
    expect(clampExploreLimit(26)).toBe(25);
  });

  it("passes a valid value through, truncated to an integer", () => {
    expect(clampExploreLimit(10)).toBe(10);
    expect(clampExploreLimit(10.9)).toBe(10);
    expect(clampExploreLimit(25)).toBe(25);
  });
});

describe("clampExploreOffset", () => {
  it("floors negative, missing or non-finite values at 0", () => {
    expect(clampExploreOffset(undefined)).toBe(0);
    expect(clampExploreOffset(-5)).toBe(0);
    expect(clampExploreOffset(Number.NaN)).toBe(0);
  });

  it("passes a valid value through, truncated to an integer", () => {
    expect(clampExploreOffset(40)).toBe(40);
    expect(clampExploreOffset(40.7)).toBe(40);
  });
});

describe("parseExploreSearch", () => {
  it("returns null when q is missing or too short", () => {
    expect(parseExploreSearch({ q: "" })).toBeNull();
    expect(parseExploreSearch({ q: "  x " })).toBeNull();
  });

  it("trims q and computes its accent-folded form", () => {
    const result = parseExploreSearch({ q: "  Développeur  " });
    expect(result?.q).toBe("Développeur");
    expect(result?.foldedQ).toBe("developpeur");
  });

  it("normalizes blank location/source to null", () => {
    const result = parseExploreSearch({ q: "c++", location: "   ", source: "" });
    expect(result?.location).toBeNull();
    expect(result?.source).toBeNull();
  });

  it("trims a real location/source", () => {
    const result = parseExploreSearch({ q: "c++", location: " Paris ", source: " Greenhouse " });
    expect(result?.location).toBe("Paris");
    expect(result?.source).toBe("Greenhouse");
  });

  it("caps limit and floors offset the same way the standalone helpers do", () => {
    const result = parseExploreSearch({ q: "c++", limit: 999, offset: -3 });
    expect(result?.limit).toBe(MAX_LIMIT);
    expect(result?.offset).toBe(0);
  });

  it("defaults limit/offset when not given", () => {
    const result = parseExploreSearch({ q: "c++" });
    expect(result?.limit).toBe(DEFAULT_LIMIT);
    expect(result?.offset).toBe(0);
  });
});

describe("toExplorePostingCard", () => {
  const baseRow: ExplorePostingRow = {
    id: 1,
    source: "Greenhouse",
    title: "Backend Engineer",
    company: "Acme",
    location: "Paris",
    workMode: "Remote",
    description: "<p>Build things.</p>",
    postedDate: "2026-08-01",
    inMyQueue: false,
  };

  it("strips HTML and passes every other field through unchanged", () => {
    const card = toExplorePostingCard(baseRow);
    expect(card.descriptionExcerpt).toBe("Build things.");
    expect(card).not.toHaveProperty("description");
    expect(card.id).toBe(1);
    expect(card.inMyQueue).toBe(false);
  });

  it("truncates a long description to DESCRIPTION_EXCERPT_LENGTH on a word boundary", () => {
    const long = "word ".repeat(200).trim();
    const card = toExplorePostingCard({ ...baseRow, description: long });
    expect(card.descriptionExcerpt.length).toBeLessThanOrEqual(DESCRIPTION_EXCERPT_LENGTH + 1);
    expect(card.descriptionExcerpt.endsWith("…")).toBe(true);
  });

  it("carries inMyQueue through both ways", () => {
    expect(toExplorePostingCard({ ...baseRow, inMyQueue: true }).inMyQueue).toBe(true);
    expect(toExplorePostingCard({ ...baseRow, inMyQueue: false }).inMyQueue).toBe(false);
  });
});
