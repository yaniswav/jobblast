import { Check } from 'lucide-react';
import { TagEditor } from '@/pages/profile';
import { useT, type TranslationKey } from '@/i18n';

// Shared between the onboarding wizard's criteria step (pages/onboarding.tsx)
// and the Settings page's search criteria section (pages/settings.tsx): both
// edit the exact same three fields (settings.searchCriteria), so the "add a
// tag / remove a tag / pick a language" UI lives here once rather than
// twice.

export const LANGUAGE_OPTIONS: { code: string; labelKey: TranslationKey }[] = [
  { code: 'en', labelKey: 'onboarding.langEnglish' },
  { code: 'fr', labelKey: 'onboarding.langFrench' },
  { code: 'es', labelKey: 'onboarding.langSpanish' },
  { code: 'de', labelKey: 'onboarding.langGerman' },
  { code: 'ja', labelKey: 'onboarding.langJapanese' },
  { code: 'zh', labelKey: 'onboarding.langChinese' },
];

export function SearchCriteriaFields({
  testIdPrefix,
  keywords,
  newKeyword,
  setNewKeyword,
  onAddKeyword,
  onRemoveKeyword,
  locations,
  newLocation,
  setNewLocation,
  onAddLocation,
  onRemoveLocation,
  languages,
  onToggleLanguage,
}: {
  /** Keeps each page's data-testid values distinct (and the onboarding wizard's unchanged from before this was extracted). */
  testIdPrefix: string;
  keywords: string[];
  newKeyword: string;
  setNewKeyword: (value: string) => void;
  onAddKeyword: () => void;
  onRemoveKeyword: (value: string) => void;
  locations: string[];
  newLocation: string;
  setNewLocation: (value: string) => void;
  onAddLocation: () => void;
  onRemoveLocation: (value: string) => void;
  languages: string[];
  onToggleLanguage: (code: string) => void;
}) {
  const t = useT();
  return (
    <div className="grid gap-5">
      <TagEditor
        label={t('onboarding.keywordsLabel')}
        values={keywords}
        draft={newKeyword}
        setDraft={setNewKeyword}
        onAdd={onAddKeyword}
        onRemove={onRemoveKeyword}
        placeholder={t('onboarding.keywordsPlaceholder')}
        testId={`${testIdPrefix}-keyword`}
      />
      <TagEditor
        label={t('onboarding.locationsLabel')}
        values={locations}
        draft={newLocation}
        setDraft={setNewLocation}
        onAdd={onAddLocation}
        onRemove={onRemoveLocation}
        placeholder={t('onboarding.locationsPlaceholder')}
        testId={`${testIdPrefix}-location`}
      />
      <div>
        <label className="label">{t('onboarding.letterLanguagesLabel')}</label>
        <div className="flex flex-wrap gap-2 mt-1">
          {LANGUAGE_OPTIONS.map((option) => {
            const active = languages.includes(option.code);
            return (
              <button
                key={option.code}
                type="button"
                className={`tag cursor-pointer ${active ? 'badge-green' : ''}`}
                onClick={() => onToggleLanguage(option.code)}
                aria-pressed={active}
                data-testid={`button-${testIdPrefix}-language-${option.code}`}
              >
                {active && <Check size={11} className="mr-1" />}
                {t(option.labelKey)}
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}
