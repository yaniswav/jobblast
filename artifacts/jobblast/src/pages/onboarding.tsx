import { type ChangeEvent, useEffect, useRef, useState } from 'react';
import { Check, Upload } from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import {
  getGetDashboardQueryKey,
  getGetOnboardingStatusQueryKey,
  getGetProfileQueryKey,
  getGetSettingsQueryKey,
  useCompleteOnboarding,
  useGetProfile,
  useGetSettings,
  useListAiCredentials,
  useLogout,
  useUpdateProfile,
  useUpdateSettings,
  useUploadDocument,
  type AiProviderId,
  type OnboardingStep,
} from '@workspace/api-client-react';
import { useT } from '@/i18n';
import { ByokSection, PROVIDER_LABELS } from '@/pages/settings';
import { SearchCriteriaFields } from '@/components/search-criteria-fields';

// Neutral placeholders `ensureProfile()` seeds a brand-new row with
// (artifacts/api-server/src/lib/repo/profile.ts). Matched by prefix rather
// than exact text so a trailing-whitespace difference does not wedge the
// "Continue" button - the backend's own `resumeOnboardingStep` detection
// does the exact comparison that actually gates redirects; this is only a
// same-page UX nicety.
const HEADLINE_PLACEHOLDER_PREFIX = 'Add a one-line headline';
const RESUME_PLACEHOLDER_PREFIX = 'Paste your master resume here';

function isPlaceholder(value: string, prefix: string): boolean {
  const trimmed = value.trim();
  return trimmed.length === 0 || trimmed.startsWith(prefix);
}

const STEP_ORDER: OnboardingStep[] = ['profile', 'criteria', 'byok'];
type WizardStep = OnboardingStep | 'finish';

/**
 * The G1 onboarding wizard: profile, search criteria, optional BYOK, finish.
 * Rendered by App.tsx's OnboardingGate instead of the normal app shell -
 * never shown in selfhosted, never shown to an account that already
 * finished it.
 */
export default function Onboarding({ nextStep }: { nextStep: OnboardingStep }) {
  const t = useT();
  const logout = useLogout();
  const [step, setStep] = useState<WizardStep>(nextStep);
  const stepIndex = step === 'finish' ? STEP_ORDER.length : STEP_ORDER.indexOf(step);

  return (
    <div className="min-h-screen w-full bg-gray-50 flex flex-col items-center px-4 py-10">
      <header className="w-full max-w-2xl flex items-center justify-between mb-8">
        <div className="flex items-center gap-3">
          <span className="brand-mark">JB</span>
          <span className="font-mono-app text-[15px] font-bold tracking-[-.08em]">
            jobblast<span className="text-[hsl(var(--primary))]">.</span>
          </span>
        </div>
        <button
          type="button"
          className="text-xs text-gray-500 underline underline-offset-4"
          onClick={() => logout.mutate(undefined, { onSuccess: () => window.location.reload() })}
          data-testid="button-onboarding-sign-out"
        >
          {t('onboarding.signOut')}
        </button>
      </header>

      <div className="w-full max-w-2xl mb-7" data-testid="status-onboarding-progress">
        <div className="flex items-center gap-2" role="list" aria-label={t('onboarding.stepsAriaLabel')}>
          {STEP_ORDER.map((candidate, index) => (
            <div
              key={candidate}
              role="listitem"
              className={`h-1.5 flex-1 rounded-full transition-colors ${index <= stepIndex ? 'bg-[hsl(var(--primary))]' : 'bg-[hsl(var(--border))]'}`}
            />
          ))}
        </div>
        <p className="text-xs text-gray-500 mt-2">
          {t('onboarding.stepCount', { current: Math.min(stepIndex + 1, STEP_ORDER.length), total: STEP_ORDER.length })}
        </p>
      </div>

      <div className="w-full max-w-2xl">
        {step === 'profile' && <ProfileStep onNext={() => setStep('criteria')} />}
        {step === 'criteria' && <CriteriaStep onNext={() => setStep('byok')} onBack={() => setStep('profile')} />}
        {step === 'byok' && <ByokStep onNext={() => setStep('finish')} onBack={() => setStep('criteria')} />}
        {step === 'finish' && <FinishStep onBack={() => setStep('byok')} />}
      </div>
    </div>
  );
}

function StepHeading({ eyebrow, title, subtitle }: { eyebrow: string; title: string; subtitle: string }) {
  return (
    <section className="mb-6">
      <div className="eyebrow">{eyebrow}</div>
      <div className="mt-3">
        <h1 className="page-title text-[28px] sm:text-[32px]">{title}</h1>
        <p className="page-subtitle">{subtitle}</p>
      </div>
    </section>
  );
}

function LoadingCard() {
  const t = useT();
  return (
    <section className="surface p-6" data-testid="status-onboarding-loading">
      <p className="text-sm text-[hsl(var(--muted-foreground))]">{t('loading.workspace')}</p>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Step a: profile (paste or upload a resume, plus a headline)
// ---------------------------------------------------------------------------

function ProfileStep({ onNext }: { onNext: () => void }) {
  const t = useT();
  const profile = useGetProfile();
  const update = useUpdateProfile();
  const upload = useUploadDocument();
  const queryClient = useQueryClient();
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [headline, setHeadline] = useState('');
  const [masterResume, setMasterResume] = useState('');

  // Same pattern as pages/profile.tsx: re-syncs from the server on every
  // fetch of GET /profile, including the refetch a CV upload triggers below
  // (so extracted resume text lands in this field automatically).
  useEffect(() => {
    if (!profile.data) return;
    setHeadline(profile.data.headline);
    setMasterResume(profile.data.masterResume);
  }, [profile.data]);

  const handleFile = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    if (file.type !== 'application/pdf') {
      toast(t('profile.toastPdfOnly'));
      return;
    }
    upload.mutate(
      { type: 'cv', data: { file } },
      {
        onSuccess: (result) => {
          queryClient.invalidateQueries({ queryKey: getGetProfileQueryKey() });
          toast(result.resumeUpdated ? t('profile.toastCvUpdatedResume') : t('profile.toastCvUpdated'));
        },
        onError: () => toast(t('profile.toastUploadFailed')),
      },
    );
  };

  const ready = !isPlaceholder(headline, HEADLINE_PLACEHOLDER_PREFIX) && !isPlaceholder(masterResume, RESUME_PLACEHOLDER_PREFIX);

  const save = () => {
    update.mutate(
      { data: { headline, masterResume } },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getGetProfileQueryKey() });
          onNext();
        },
        onError: () => toast(t('onboarding.toastSaveFailed')),
      },
    );
  };

  if (profile.isLoading) return <LoadingCard />;

  return (
    <>
      <StepHeading
        eyebrow={t('onboarding.stepProfileEyebrow')}
        title={t('onboarding.stepProfileTitle')}
        subtitle={t('onboarding.stepProfileSubtitle')}
      />
      <section className="surface p-6">
        <div className="grid gap-4">
          <div>
            <label className="label" htmlFor="onboarding-headline">
              {t('profile.headline')}
            </label>
            <input
              id="onboarding-headline"
              className="input"
              value={headline}
              onChange={(event) => setHeadline(event.target.value)}
              placeholder={t('onboarding.headlinePlaceholder')}
              data-testid="input-onboarding-headline"
            />
          </div>
          <div>
            <div className="section-heading">
              <div>
                <h2>{t('profile.masterResume')}</h2>
                <p>{t('onboarding.resumeHint')}</p>
              </div>
              <button
                type="button"
                className="btn btn-ghost"
                onClick={() => fileInputRef.current?.click()}
                disabled={upload.isPending}
                data-testid="button-onboarding-upload-cv"
              >
                <Upload size={14} /> {upload.isPending ? t('onboarding.saving') : t('onboarding.uploadCvButton')}
              </button>
            </div>
            <input
              ref={fileInputRef}
              type="file"
              accept="application/pdf"
              className="hidden"
              onChange={handleFile}
              data-testid="input-onboarding-cv-file"
            />
            <textarea
              className="textarea min-h-[220px] mt-1"
              value={masterResume}
              onChange={(event) => setMasterResume(event.target.value)}
              placeholder={t('profile.masterResumePlaceholder')}
              data-testid="textarea-onboarding-resume"
            />
          </div>
        </div>
      </section>
      <div className="flex justify-end mt-5">
        <button
          className="btn btn-primary"
          onClick={save}
          disabled={!ready || update.isPending}
          data-testid="button-onboarding-profile-continue"
        >
          {update.isPending ? t('onboarding.saving') : t('onboarding.continueButton')}
        </button>
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------
// Step b: search criteria (keywords, target locations, letter languages)
// ---------------------------------------------------------------------------

function CriteriaStep({ onNext, onBack }: { onNext: () => void; onBack: () => void }) {
  const t = useT();
  const settings = useGetSettings();
  const update = useUpdateSettings();
  const queryClient = useQueryClient();

  const [keywords, setKeywords] = useState<string[]>([]);
  const [newKeyword, setNewKeyword] = useState('');
  const [locations, setLocations] = useState<string[]>([]);
  const [newLocation, setNewLocation] = useState('');
  const [languages, setLanguages] = useState<string[]>(['en']);

  useEffect(() => {
    if (!settings.data) return;
    setKeywords(settings.data.searchCriteria.keywords);
    setLocations(settings.data.searchCriteria.targetLocationKeywords);
    if (settings.data.searchCriteria.letterLanguages.length > 0) {
      setLanguages(settings.data.searchCriteria.letterLanguages);
    }
  }, [settings.data]);

  const addKeyword = () => {
    const value = newKeyword.trim();
    if (value && !keywords.includes(value)) setKeywords((current) => [...current, value]);
    setNewKeyword('');
  };
  const removeKeyword = (value: string) => setKeywords((current) => current.filter((item) => item !== value));
  const addLocation = () => {
    const value = newLocation.trim();
    if (value && !locations.includes(value)) setLocations((current) => [...current, value]);
    setNewLocation('');
  };
  const removeLocation = (value: string) => setLocations((current) => current.filter((item) => item !== value));
  const toggleLanguage = (code: string) =>
    setLanguages((current) => (current.includes(code) ? current.filter((item) => item !== code) : [...current, code]));

  const save = () => {
    update.mutate(
      {
        data: {
          searchCriteria: {
            keywords,
            targetLocationKeywords: locations,
            letterLanguages: languages.length > 0 ? languages : ['en'],
          },
        },
      },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getGetSettingsQueryKey() });
          onNext();
        },
        onError: () => toast(t('settings.toastSettingsSaveFailed')),
      },
    );
  };

  if (settings.isLoading) return <LoadingCard />;

  return (
    <>
      <StepHeading
        eyebrow={t('onboarding.stepCriteriaEyebrow')}
        title={t('onboarding.stepCriteriaTitle')}
        subtitle={t('onboarding.stepCriteriaSubtitle')}
      />
      <section className="surface p-6">
        <SearchCriteriaFields
          testIdPrefix="onboarding"
          keywords={keywords}
          newKeyword={newKeyword}
          setNewKeyword={setNewKeyword}
          onAddKeyword={addKeyword}
          onRemoveKeyword={removeKeyword}
          locations={locations}
          newLocation={newLocation}
          setNewLocation={setNewLocation}
          onAddLocation={addLocation}
          onRemoveLocation={removeLocation}
          languages={languages}
          onToggleLanguage={toggleLanguage}
        />
      </section>
      <div className="flex justify-between mt-5">
        <button className="btn btn-ghost" onClick={onBack} data-testid="button-onboarding-criteria-back">
          {t('onboarding.backButton')}
        </button>
        <button
          className="btn btn-primary"
          onClick={save}
          disabled={update.isPending}
          data-testid="button-onboarding-criteria-continue"
        >
          {update.isPending ? t('onboarding.saving') : t('onboarding.continueButton')}
        </button>
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------
// Step c: BYOK (optional). Reuses the exact credential cards from Settings.
// ---------------------------------------------------------------------------

function ByokStep({ onNext, onBack }: { onNext: () => void; onBack: () => void }) {
  const t = useT();
  const credentials = useListAiCredentials();
  const update = useUpdateSettings();
  const queryClient = useQueryClient();

  const configured = credentials.data?.find((credential) => credential.configured);
  const providerLabel = configured ? (PROVIDER_LABELS[configured.provider] ?? configured.provider) : '';

  // Whichever path the account takes here, `ai.provider` ends up explicit
  // rather than left on the schema's default ("claude-cli", which is
  // meaningless in saas - no CLI to find on a shared server process): a
  // configured BYOK key gets selected, an unconfigured one gets "none".
  const commit = (provider: AiProviderId) => {
    update.mutate(
      { data: { ai: { provider, model: '' } } },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getGetSettingsQueryKey() });
          onNext();
        },
        onError: () => toast(t('settings.toastSettingsSaveFailed')),
      },
    );
  };

  return (
    <>
      <StepHeading
        eyebrow={t('onboarding.stepByokEyebrow')}
        title={t('onboarding.stepByokTitle')}
        subtitle={t('onboarding.stepByokSubtitle')}
      />
      <ByokSection t={t} />
      <section className="surface p-6 mt-5">
        <p className="text-sm text-[hsl(var(--muted-foreground))]">
          {configured ? t('onboarding.byokConfiguredHint', { provider: providerLabel }) : t('onboarding.byokSkipHint')}
        </p>
        <div className="flex justify-between mt-4">
          <button className="btn btn-ghost" onClick={onBack} data-testid="button-onboarding-byok-back">
            {t('onboarding.backButton')}
          </button>
          {configured ? (
            <button
              className="btn btn-primary"
              onClick={() => commit(configured.provider)}
              disabled={update.isPending}
              data-testid="button-onboarding-byok-continue"
            >
              {update.isPending ? t('onboarding.saving') : t('onboarding.byokContinueButton', { provider: providerLabel })}
            </button>
          ) : (
            <button
              className="btn btn-ghost"
              onClick={() => commit('none')}
              disabled={update.isPending}
              data-testid="button-onboarding-byok-skip"
            >
              {update.isPending ? t('onboarding.saving') : t('onboarding.skipButton')}
            </button>
          )}
        </div>
      </section>
    </>
  );
}

// ---------------------------------------------------------------------------
// Step d: finish - marks onboarding done and enqueues the first refresh.
// ---------------------------------------------------------------------------

function FinishStep({ onBack }: { onBack: () => void }) {
  const t = useT();
  const complete = useCompleteOnboarding();
  const queryClient = useQueryClient();

  const finish = () => {
    complete.mutate(undefined, {
      onSuccess: () => {
        // The OnboardingGate in App.tsx re-renders off this query: once it
        // refetches and reports `completed: true`, the wizard unmounts and
        // the real app (with the dashboard's "first batch on its way" state)
        // takes over - no client-side navigation needed.
        queryClient.invalidateQueries({ queryKey: getGetOnboardingStatusQueryKey() });
        queryClient.invalidateQueries({ queryKey: getGetDashboardQueryKey() });
      },
      onError: () => toast(t('onboarding.toastCompleteFailed')),
    });
  };

  return (
    <>
      <StepHeading
        eyebrow={t('onboarding.stepFinishEyebrow')}
        title={t('onboarding.stepFinishTitle')}
        subtitle={t('onboarding.stepFinishSubtitle')}
      />
      <section className="surface p-6">
        <ul className="grid gap-3 text-sm">
          <li className="flex items-center gap-2">
            <Check size={15} className="text-[hsl(var(--primary))] flex-none" /> {t('onboarding.finishChecklistProfile')}
          </li>
          <li className="flex items-center gap-2">
            <Check size={15} className="text-[hsl(var(--primary))] flex-none" /> {t('onboarding.finishChecklistCriteria')}
          </li>
          <li className="flex items-center gap-2">
            <Check size={15} className="text-[hsl(var(--primary))] flex-none" /> {t('onboarding.finishChecklistByok')}
          </li>
        </ul>
      </section>
      <div className="flex justify-between mt-5">
        <button className="btn btn-ghost" onClick={onBack} disabled={complete.isPending} data-testid="button-onboarding-finish-back">
          {t('onboarding.backButton')}
        </button>
        <button
          className="btn btn-primary"
          onClick={finish}
          disabled={complete.isPending}
          data-testid="button-onboarding-finish"
        >
          {complete.isPending ? t('onboarding.saving') : t('onboarding.finishButton')}
        </button>
      </div>
    </>
  );
}
