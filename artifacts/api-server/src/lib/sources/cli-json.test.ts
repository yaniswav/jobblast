import { describe, expect, it } from "vitest";
import { extractJsonArrayText, parseJsonArrayResponse } from "./cli-json";

describe("parseJsonArrayResponse", () => {
  it("parses a clean JSON array", () => {
    expect(parseJsonArrayResponse('[{"a":1},{"a":2}]')).toEqual([{ a: 1 }, { a: 2 }]);
  });

  it("recovers an array wrapped in a markdown code fence", () => {
    const raw = '```json\n[{"a":1}]\n```';
    expect(parseJsonArrayResponse(raw)).toEqual([{ a: 1 }]);
  });

  it("recovers an array followed by trailing commentary the model added anyway", () => {
    const raw = '[{"a":1},{"a":2}]\n\nThat is the full list of postings.';
    expect(parseJsonArrayResponse(raw)).toEqual([{ a: 1 }, { a: 2 }]);
  });

  it("returns null for text with no array in it at all", () => {
    expect(parseJsonArrayResponse("Sorry, I could not find any postings.")).toBeNull();
  });

  it("returns null for an array that never closes", () => {
    expect(parseJsonArrayResponse('[{"a":1}, {"a":2}')).toBeNull();
  });

  it("returns null for a top-level object with no array", () => {
    expect(parseJsonArrayResponse('{"error":"no results"}')).toBeNull();
  });
});

describe("extractJsonArrayText", () => {
  it("does not let brackets inside a string literal confuse the bracket count", () => {
    const raw = '[{"desc":"complexity is O(n) for arrays like [1,2] here"},{"b":2}] trailing junk';
    expect(extractJsonArrayText(raw)).toBe(
      '[{"desc":"complexity is O(n) for arrays like [1,2] here"},{"b":2}]',
    );
  });

  it("respects an escaped quote inside the string so it doesn't end the string early", () => {
    const raw = String.raw`[{"note":"a \"quoted\" [word]"}] extra`;
    expect(extractJsonArrayText(raw)).toBe(String.raw`[{"note":"a \"quoted\" [word]"}]`);
  });

  it("returns null when no '[' is present", () => {
    expect(extractJsonArrayText("no brackets here")).toBeNull();
  });
});
