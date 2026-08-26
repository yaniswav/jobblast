// Shared language-rule helpers for the AI prompt builders (tailor.ts,
// fit-analysis.ts). Both need to tell the model the same thing: write in one
// of the candidate's `candidate.letterLanguages` if the job posting is
// written in one of those languages, otherwise write in
// `candidate.fallbackLetterLanguage`. Factored out of tailor.ts, which was
// the first prompt builder to need this.

import { loadConfig } from "../config";

/** ISO 639-1 -> English language name, for prompts. Unknown codes pass through. */
// Looked up by an arbitrary ISO code below, so the `string` index signature
// is load-bearing.
// eslint-disable-next-line anti-slop/no-known-value-widening
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

/** The account's configured letter languages, defaulting to just the fallback when the list is empty. */
function resolveLetterLanguages() {
  const { candidate } = loadConfig();
  const letterLanguages =
    candidate.letterLanguages.length > 0 ? candidate.letterLanguages : [candidate.fallbackLetterLanguage];
  return { letterLanguages, fallbackLetterLanguage: candidate.fallbackLetterLanguage };
}

/**
 * Resolves the candidate's letter-language rule from config, formatted for
 * direct interpolation into a prompt: the language(s) the applicant writes
 * in, and the fallback used when the posting matches none of them.
 */
export function letterLanguageRule() {
  const { letterLanguages, fallbackLetterLanguage } = resolveLetterLanguages();
  return {
    letterLanguageNames: formatList(letterLanguages.map(languageName)),
    fallbackLanguageName: languageName(fallbackLetterLanguage),
  };
}

/**
 * How many whole-word hits of `words` appear in `text` (case-insensitive).
 * Used only by detectLetterLanguage below.
 */
function functionWordScore(text: string, words: readonly string[]): number {
  let score = 0;
  for (const word of words) {
    const matches = text.match(new RegExp(`\\b${word}\\b`, "gi"));
    if (matches) score += matches.length;
  }
  return score;
}

/**
 * A handful of very common function words per language, used only to guess
 * which language a short piece of text (a job posting) is written in when
 * there is no model available to just read it. Deliberately small: this is
 * not a general-purpose language detector, it only needs to tell apart the
 * languages an account has actually listed in `letterLanguages`.
 */
// Looked up by an arbitrary ISO code below, so the `string` index signature
// is load-bearing.
// eslint-disable-next-line anti-slop/no-known-value-widening
const FUNCTION_WORDS: Record<string, readonly string[]> = {
  en: ["the", "and", "you", "your", "our", "role", "company", "team", "with", "this", "are", "for"],
  fr: ["le", "la", "les", "des", "une", "un", "et", "vous", "nous", "votre", "notre", "poste", "entreprise", "pour"],
  de: ["der", "die", "das", "und", "sie", "ihr", "unser", "unternehmen", "team", "mit", "für"],
  es: ["el", "la", "los", "las", "y", "usted", "su", "nuestro", "empresa", "equipo", "para", "con"],
  it: ["il", "lo", "la", "gli", "le", "e", "voi", "vostro", "nostro", "azienda", "squadra", "per", "con"],
  pt: ["o", "a", "os", "as", "e", "você", "seu", "nossa", "empresa", "equipe", "para", "com"],
  nl: ["de", "het", "en", "u", "uw", "ons", "bedrijf", "team", "voor", "met"],
};

/**
 * Deterministic guess of which of `letterLanguages` a piece of text (a job
 * posting's title + description) is written in - `fallbackLetterLanguage`
 * when nothing recognizable is found, or when the text is too short to say.
 * Ties keep the first candidate language that reached the top score.
 *
 * This exists for callers that must pick ONE language WITHOUT an AI model to
 * read the text (lib/ai/follow-up.ts's deterministic template). Every AI
 * prompt in this app instead hands the model the same "if the posting is
 * written in X, write in X, else write in the fallback" rule via
 * letterLanguageRule() and lets it read the posting itself - see tailor.ts,
 * fit-analysis.ts, interview-brief.ts.
 */
export function detectLetterLanguage(
  text: string,
  letterLanguages: readonly string[],
  fallbackLetterLanguage: string,
): string {
  let best: { language: string; score: number } | null = null;
  for (const language of letterLanguages) {
    const words = FUNCTION_WORDS[language.trim().toLowerCase()];
    if (!words) continue;
    const score = functionWordScore(text, words);
    if (score > 0 && (!best || score > best.score)) best = { language, score };
  }
  return best?.language ?? fallbackLetterLanguage;
}

/** detectLetterLanguage(), resolving `letterLanguages`/`fallbackLetterLanguage` from config. */
export function detectAccountLetterLanguage(text: string): string {
  const { letterLanguages, fallbackLetterLanguage } = resolveLetterLanguages();
  return detectLetterLanguage(text, letterLanguages, fallbackLetterLanguage);
}
