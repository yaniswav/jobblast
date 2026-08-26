import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { en, type TranslationKey } from './en';
import { fr } from './fr';

export type Locale = 'en' | 'fr';

const STORAGE_KEY = 'jobblast.locale';

const dictionaries = { en, fr } satisfies Record<Locale, Record<TranslationKey, string>>;

type Vars = Record<string, string | number>;

function interpolate(template: string, vars?: Vars): string {
  if (!vars) return template;
  return template.replace(/\{(\w+)\}/g, (match, key: string) => (key in vars ? String(vars[key]) : match));
}

function readStoredLocale(): Locale | null {
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    return stored === 'en' || stored === 'fr' ? stored : null;
  } catch {
    // localStorage can throw in private browsing / restricted contexts.
    return null;
  }
}

/**
 * Resolution order: an explicit choice saved in localStorage, then the
 * browser's language, then English for everyone else.
 */
function detectLocale(): Locale {
  if (typeof window === 'undefined') return 'en';
  const stored = readStoredLocale();
  if (stored) return stored;
  const browserLanguage = typeof navigator !== 'undefined' ? navigator.language : '';
  return browserLanguage?.toLowerCase().startsWith('fr') ? 'fr' : 'en';
}

interface I18nContextValue {
  locale: Locale;
  setLocale: (locale: Locale) => void;
  t: (key: TranslationKey, vars?: Vars) => string;
}

function translate(locale: Locale, key: TranslationKey, vars?: Vars): string {
  const template = dictionaries[locale][key] ?? dictionaries.en[key] ?? key;
  return interpolate(template, vars);
}

function noopSetLocale(): void {
  // No-op default so useT()/useLocale() work even outside <I18nProvider> -
  // notably the top-level error boundary in main.tsx, which wraps the whole
  // <App/> (and therefore the provider) and can render its fallback without
  // it ever having mounted.
}

// Default value computed once at module load so components rendered outside
// the provider still get a working, correctly-resolved translator.
const defaultValue: I18nContextValue = {
  locale: detectLocale(),
  setLocale: noopSetLocale,
  t: (key, vars) => translate(detectLocale(), key, vars),
};

const I18nContext = createContext<I18nContextValue>(defaultValue);

export function I18nProvider({ children }: { children: ReactNode }) {
  const [locale, setLocaleState] = useState<Locale>(() => detectLocale());

  useEffect(() => {
    document.documentElement.lang = locale;
  }, [locale]);

  const setLocale = useCallback((next: Locale) => {
    setLocaleState(next);
    try {
      window.localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // Ignore storage failures (e.g. private browsing); the choice still
      // applies for the current session.
    }
  }, []);

  const value = useMemo<I18nContextValue>(
    () => ({ locale, setLocale, t: (key, vars) => translate(locale, key, vars) }),
    [locale, setLocale],
  );

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useT() {
  return useContext(I18nContext).t;
}

export function useLocale(): [Locale, (locale: Locale) => void] {
  const { locale, setLocale } = useContext(I18nContext);
  return [locale, setLocale];
}
