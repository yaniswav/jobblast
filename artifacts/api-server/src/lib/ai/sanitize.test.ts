import { describe, expect, it } from "vitest";
import { sanitizeAiText, sanitizeAiTexts } from "./sanitize";

// \u escapes throughout, not literal characters: several of the tells below
// (nbsp, zero-width space) are invisible in a source file, and typing the
// wrong look-alike dash/quote would silently make the case a no-op.
const EM_DASH = "—";
const HORIZONTAL_BAR = "―";
const EN_DASH = "–";
const CURLY_SINGLE_OPEN = "‘";
const CURLY_SINGLE_CLOSE = "’";
const CURLY_DOUBLE_OPEN = "“";
const CURLY_DOUBLE_CLOSE = "”";
const ELLIPSIS = "…";
const NBSP = " ";
const ZERO_WIDTH_SPACE = "​";

describe("sanitizeAiText", () => {
  const cases: Array<[label: string, input: string, expected: string]> = [
    ["em dash -> comma", `Hello${EM_DASH}world`, "Hello, world"],
    ["horizontal bar -> comma", `Hello${HORIZONTAL_BAR}world`, "Hello, world"],
    ["spaced en dash -> comma", `Monday ${EN_DASH} Friday`, "Monday, Friday"],
    ["unspaced en dash -> hyphen", `pages 12${EN_DASH}15`, "pages 12-15"],
    [
      "curly single quotes -> straight",
      `It${CURLY_SINGLE_CLOSE}s a ${CURLY_SINGLE_OPEN}test${CURLY_SINGLE_CLOSE}`,
      "It's a 'test'",
    ],
    [
      "curly double quotes -> straight",
      `She said ${CURLY_DOUBLE_OPEN}hi${CURLY_DOUBLE_CLOSE}`,
      'She said "hi"',
    ],
    ["ellipsis char -> three dots", `Wait${ELLIPSIS}`, "Wait..."],
    ["non-breaking space -> space", `Hello${NBSP}World`, "Hello World"],
    ["zero-width space -> removed", `Hello${ZERO_WIDTH_SPACE}World`, "HelloWorld"],
    ["double spaces collapse", "Hello  World", "Hello World"],
    ["space before comma -> none", "word , word", "word, word"],
    ["doubled commas collapse", "one,,two", "one,two"],
    [
      // \s* around the dash rules eats a leading newline along with the
      // dash, so a dash-led *first* line - not a later one - is what turns
      // into a leading ", " for this rule to then strip.
      "a dash opening the whole text is cleaned up to a plain sentence start",
      `${EM_DASH} This role involves great things.`,
      "This role involves great things.",
    ],
    [
      "a stray leading comma on a later line (not from a dash) is stripped too",
      "Intro line.\n, continued after a stray leading comma.",
      "Intro line.\ncontinued after a stray leading comma.",
    ],
    ["trims the result", "  padded text  ", "padded text"],
  ];

  it.each(cases)("%s", (_label, input, expected) => {
    expect(sanitizeAiText(input)).toBe(expected);
  });

  it("combines several tells in one realistic AI sentence", () => {
    const input =
      `The role${EM_DASH}based in Paris${EM_DASH}needs 5${EN_DASH}7 years${CURLY_SINGLE_CLOSE} experience ` +
      `with ${CURLY_DOUBLE_OPEN}modern${CURLY_DOUBLE_CLOSE} tooling${ELLIPSIS}`;
    const expected = "The role, based in Paris, needs 5-7 years' experience with \"modern\" tooling...";
    expect(sanitizeAiText(input)).toBe(expected);
  });
});

describe("sanitizeAiTexts", () => {
  it("maps sanitizeAiText over every element", () => {
    expect(sanitizeAiTexts([`a${EM_DASH}b`, `c${ELLIPSIS}`])).toEqual(["a, b", "c..."]);
  });
});
