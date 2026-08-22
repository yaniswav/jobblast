// Post-processing for AI-generated text (cover letters, resume bullets).
//
// LLM output carries typographic tells that recruiters increasingly
// recognise: em/en dashes, curly quotes, ellipsis characters, non-breaking
// spaces. This normalises them to plain punctuation so the text reads like
// something typed by a person. Applied after generation, before the DB write,
// so PDFs and the UI both show the sanitised version.

const REPLACEMENTS: Array<[RegExp, string]> = [
  [/\s*[\u2014\u2015]\s*/g, ", "], // em dash / horizontal bar -> comma
  [/\s+[\u2013]\s+/g, ", "], // spaced en dash -> comma
  [/[\u2013\u2012]/g, "-"], // remaining en dash / figure dash -> hyphen
  [/[\u2018\u2019\u201A\u2032]/g, "'"], // curly single quotes
  [/[\u201C\u201D\u201E\u2033]/g, '"'], // curly double quotes
  [/\u2026/g, "..."], // ellipsis character
  [/[\u00A0\u202F\u2009]/g, " "], // non-breaking / thin spaces
  [/\u200B/g, ""], // zero-width space
  [/[ \t]{2,}/g, " "], // collapse double spaces left by replacements
  [/ ,/g, ","], // "word , word" -> "word, word"
  [/,{2,}/g, ","],
];

export function sanitizeAiText(text: string): string {
  let out = text;
  for (const [pattern, replacement] of REPLACEMENTS) out = out.replace(pattern, replacement);
  // Fix sentence starts that became ", Word" at the beginning of a line.
  out = out.replace(/^,\s*/gm, "");
  return out.trim();
}

export function sanitizeAiTexts(texts: string[]): string[] {
  return texts.map(sanitizeAiText);
}
