import { Check } from 'lucide-react';
import type { FranceTravailContractType } from '@workspace/api-client-react';
import { TagEditor } from '@/pages/profile';
import { useT, type TranslationKey } from '@/i18n';
import { LOCATION_SUGGESTIONS, SKILL_SUGGESTIONS } from '@/lib/suggestions';

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

// French contract types (lot H3) - only France Travail's fetcher filters on
// these (lib/sources/francetravail.ts). "stage" has no code in that API at
// all (see FRANCE_TRAVAIL_CONTRACT_TYPES in api-server/lib/config.ts), so it
// is shown with a note instead of hidden - the gap should be visible, not
// silent.
export const CONTRACT_TYPE_OPTIONS: { code: FranceTravailContractType; labelKey: TranslationKey }[] = [
  { code: 'cdi', labelKey: 'onboarding.contractTypeCdi' },
  { code: 'cdd', labelKey: 'onboarding.contractTypeCdd' },
  { code: 'interim', labelKey: 'onboarding.contractTypeInterim' },
  { code: 'alternance', labelKey: 'onboarding.contractTypeAlternance' },
  { code: 'stage', labelKey: 'onboarding.contractTypeStage' },
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
  contractTypes,
  onToggleContractType,
}: {
  /** Keeps each page's data-testid values distinct (and the onboarding wizard's unchanged from before this was extracted). */
  testIdPrefix: string;
  keywords: string[];
  newKeyword: string;
  setNewKeyword: (value: string) => void;
  onAddKeyword: (value: string) => void;
  onRemoveKeyword: (value: string) => void;
  locations: string[];
  newLocation: string;
  setNewLocation: (value: string) => void;
  onAddLocation: (value: string) => void;
  onRemoveLocation: (value: string) => void;
  languages: string[];
  onToggleLanguage: (code: string) => void;
  contractTypes: FranceTravailContractType[];
  onToggleContractType: (code: FranceTravailContractType) => void;
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
        suggestions={SKILL_SUGGESTIONS}
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
        suggestions={LOCATION_SUGGESTIONS}
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
      <div>
        <label className="label">{t('onboarding.contractTypesLabel')}</label>
        <div className="flex flex-wrap gap-2 mt-1">
          {CONTRACT_TYPE_OPTIONS.map((option) => {
            const active = contractTypes.includes(option.code);
            return (
              <button
                key={option.code}
                type="button"
                className={`tag cursor-pointer ${active ? 'badge-green' : ''}`}
                onClick={() => onToggleContractType(option.code)}
                aria-pressed={active}
                data-testid={`button-${testIdPrefix}-contract-type-${option.code}`}
              >
                {active && <Check size={11} className="mr-1" />}
                {t(option.labelKey)}
              </button>
            );
          })}
        </div>
        {contractTypes.includes('stage') && (
          <p className="text-xs text-[hsl(var(--muted-foreground))] mt-1">
            {t('onboarding.contractTypeStageNote')}
          </p>
        )}
      </div>
    </div>
  );
}
