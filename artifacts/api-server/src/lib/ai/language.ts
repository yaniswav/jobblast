// Shared language-rule helpers for the AI prompt builders (tailor.ts,
// fit-analysis.ts). Both need to tell the model the same thing: write in one
// of the candidate's `candidate.letterLanguages` if the job posting is
// written in one of those languages, otherwise write in
// `candidate.fallbackLetterLanguage`. Factored out of tailor.ts, which was
// the first prompt builder to need this.

import { loadConfig } from "../config";

/** ISO 639-1 -> English language name, for prompts. Unknown codes pass through. */
const LANGUAGE_NAMES: Record<string, string> = {
  ar: "Arabic",
  de: "German",
  en: "English",
  es: "Spanish",
  fr: "French",
  it: "Italian",
  ja: "Japanese",
  ko: "Korean",
  nl: "Dutch",
  pl: "Polish",
  pt: "Portuguese",
  ru: "Russian",
  sv: "Swedish",
  tr: "Turkish",
  zh: "Chinese",
};

export function languageName(code: string): string {
  return LANGUAGE_NAMES[code.trim().toLowerCase()] ?? code;
}

export function formatList(items: string[]): string {
  if (items.length <= 1) return items[0] ?? "";
  return `${items.slice(0, -1).join(", ")} or ${items[items.length - 1]}`;
}

/**
 * Resolves the candidate's letter-language rule from config, formatted for
 * direct interpolation into a prompt: the language(s) the applicant writes
 * in, and the fallback used when the posting matches none of them.
 */
export function letterLanguageRule(): { letterLanguageNames: string; fallbackLanguageName: string } {
  const { candidate } = loadConfig();
  const letterLanguages =
    candidate.letterLanguages.length > 0 ? candidate.letterLanguages : [candidate.fallbackLetterLanguage];
  return {
    letterLanguageNames: formatList(letterLanguages.map(languageName)),
    fallbackLanguageName: languageName(candidate.fallbackLetterLanguage),
  };
}
