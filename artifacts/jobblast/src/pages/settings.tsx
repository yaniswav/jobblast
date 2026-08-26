import { Download, FlaskConical, KeyRound, Save, Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Link } from 'wouter';
import {
  getGetAccountExportUrl,
  getGetSettingsQueryKey,
  getListAiCredentialsQueryKey,
  useDeleteAccount,
  useDeleteAiCredential,
  useGetAuthSession,
  useGetSettings,
  useListAiCredentials,
  useListAiProviderOptions,
  useSaveAiCredential,
  useTestAiCredential,
  useTestAiProvider,
  useUpdateSettings,
  type AiCredentialStatus,
  type AiProviderId,
  type AiTestResult,
} from '@workspace/api-client-react';
import { ErrorState, LoadingState } from '@/components/app-shell';
import { useLocale, useT, type Locale } from '@/i18n';

// Cosmetic only - purely presentational labels for known provider ids. An id
// the backend returns that isn't in this map still renders fine (falls back
// to the raw id): the wizard is capability-driven, it never assumes which
// providers exist, it only dresses up the ones it happens to recognize.
export const PROVIDER_LABELS: Record<string, string> = {
  none: 'No AI',
  'claude-cli': 'Claude Code CLI',
  'codex-cli': 'Codex CLI',
  'gemini-cli': 'Gemini CLI',
  'anthropic-api': 'Anthropic API',
  'openai-compatible': 'OpenAI-compatible',
  ollama: 'Ollama (local)',
  lmstudio: 'LM Studio (local)',
};

export default function Settings() {
  const t = useT();
  const session = useGetAuthSession();
  // BYOK credentials and the automations section only make sense in one mode
  // each: selfhosted's provider is picked from what is detected on the
  // machine (CLIs, local servers, .env keys); saas has no machine to detect
  // anything on, so it is BYOK-only, and the automations (Gmail sync, AI
  // Scout, Notion Inbox) all need a tool-using local CLI that saas does not
  // run at all - see docs/SAAS-ARCHITECTURE.md section 10's capability
  // matrix, which explicitly hides those toggles in saas rather than
  // showing them disabled with no explanation.
  const isSaas = session.data?.mode === 'saas';
  const settings = useGetSettings();
  const options = useListAiProviderOptions();
  const update = useUpdateSettings();
  const test = useTestAiProvider();
  const queryClient = useQueryClient();

  const [selectedProvider, setSelectedProvider] = useState<string | null>(null);
  const [model, setModel] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<AiTestResult | null>(null);

  const [gmailEnabled, setGmailEnabled] = useState(false);
  const [gmailDryRun, setGmailDryRun] = useState(false);
  const [scoutEnabled, setScoutEnabled] = useState(false);
  const [notionEnabled, setNotionEnabled] = useState(false);
  const [notionPageUrl, setNotionPageUrl] = useState('');
  const [notionDataSourceUrl, setNotionDataSourceUrl] = useState('');

  useEffect(() => {
    if (!settings.data) return;
    setSelectedProvider((current) => current ?? settings.data.ai.provider);
    setModel((current) => current ?? settings.data.ai.model);
    setGmailEnabled(settings.data.gmailSync.enabled);
    setGmailDryRun(settings.data.gmailSync.dryRun);
    setScoutEnabled(settings.data.aiScout.enabled);
    setNotionEnabled(settings.data.notionInbox.enabled);
    setNotionPageUrl(settings.data.notionInbox.pageUrl);
    setNotionDataSourceUrl(settings.data.notionInbox.dataSourceUrl);
  }, [settings.data]);

  if (settings.isLoading || options.isLoading) return <LoadingState label={t('loading.settings')} />;
  if (settings.isError || !settings.data || options.isError || !options.data) {
    return (
      <div className="content-wrap">
        <ErrorState
          onRetry={() => {
            settings.refetch();
            options.refetch();
          }}
        />
      </div>
    );
  }

  const invalidate = () => queryClient.invalidateQueries({ queryKey: getGetSettingsQueryKey() });

  const saveProvider = () => {
    if (!selectedProvider) return;
    update.mutate(
      { data: { ai: { provider: selectedProvider as AiProviderId, model: model ?? '' } } },
      {
        onSuccess: () => {
          invalidate();
          setTestResult(null);
          toast(t('settings.toastSettingsSaved'));
        },
        onError: (err) => toast(err instanceof Error && err.message ? err.message : t('settings.toastSettingsSaveFailed')),
      },
    );
  };

  const runTest = () => {
    setTestResult(null);
    test.mutate(undefined, {
      onSuccess: (result) => {
        setTestResult(result);
        toast(result.ok ? t('settings.toastTestOk') : t('settings.toastTestFailed'));
      },
      onError: () => toast(t('settings.toastTestFailed')),
    });
  };

  const saveAutomations = () => {
    update.mutate(
      {
        data: {
          gmailSync: { enabled: gmailEnabled, dryRun: gmailDryRun },
          aiScout: { enabled: scoutEnabled },
          notionInbox: { enabled: notionEnabled, pageUrl: notionPageUrl, dataSourceUrl: notionDataSourceUrl },
        },
      },
      {
        onSuccess: () => {
          invalidate();
          toast(t('settings.toastSettingsSaved'));
        },
        onError: (err) => toast(err instanceof Error && err.message ? err.message : t('settings.toastSettingsSaveFailed')),
      },
    );
  };

  return (
    <div className="content-wrap">
      <section className="mb-7">
        <div className="eyebrow">{t('settings.eyebrow')}</div>
        <div className="mt-3">
          <h1 className="page-title">{t('settings.title')}</h1>
          <p className="page-subtitle">{t('settings.subtitle')}</p>
        </div>
      </section>

      <section className="surface p-6">
        <div className="section-heading">
          <div>
            <h2>{t('settings.providerSectionTitle')}</h2>
            <p>{t('settings.providerSectionSubtitle')}</p>
          </div>
        </div>

        <div className="grid gap-3 sm:grid-cols-2 mt-4">
          {options.data.map((option) => {
            const active = selectedProvider === option.id;
            return (
              <button
                key={option.id}
                type="button"
                onClick={() => setSelectedProvider(option.id)}
                className={`text-left rounded-xl border p-4 transition-colors ${active ? 'border-[hsl(var(--primary))] bg-[hsl(var(--primary)/.06)]' : 'border-[hsl(var(--border))] hover:bg-[hsl(var(--muted)/.4)]'}`}
                data-testid={`card-provider-${option.id}`}
              >
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2 font-bold text-sm">
                    <span
                      className={`h-2 w-2 rounded-full flex-none ${option.available ? 'bg-[hsl(var(--primary))]' : 'bg-[hsl(var(--muted-foreground))]'}`}
                      data-testid={`status-provider-available-${option.id}`}
                    />
                    {PROVIDER_LABELS[option.id] ?? option.id}
                  </div>
                  {active && <span className="badge badge-green">{t('settings.currentSelectionBadge')}</span>}
                </div>
                <p className="text-xs text-[hsl(var(--muted-foreground))] mt-2">{option.detail}</p>
                <div className="flex flex-wrap gap-1.5 mt-3">
                  {option.capabilities.letters && <span className="tag">{t('settings.capabilityLetters')}</span>}
                  {option.capabilities.scout && <span className="tag">{t('settings.capabilityScout')}</span>}
                  {option.capabilities.notionInbox && <span className="tag">{t('settings.capabilityNotionInbox')}</span>}
                </div>
                {!option.envSet && option.requiresEnv && (
                  <p className="text-[11px] text-[hsl(12_65%_42%)] mt-2 font-semibold">
                    {t('settings.requiresEnvHint', { env: option.requiresEnv })}
                  </p>
                )}
              </button>
            );
          })}
        </div>

        <div className="grid gap-4 sm:grid-cols-[1fr_auto_auto] items-end mt-5">
          <div>
            <label className="label" htmlFor="settings-model">
              {t('settings.modelLabel')}
            </label>
            <input
              id="settings-model"
              className="input"
              value={model ?? ''}
              onChange={(event) => setModel(event.target.value)}
              placeholder={t('settings.modelPlaceholder')}
              data-testid="input-ai-model"
            />
          </div>
          <button className="btn btn-ghost" onClick={runTest} disabled={test.isPending} data-testid="button-test-ai-provider">
            <FlaskConical size={15} /> {test.isPending ? t('settings.testing') : t('settings.testButton')}
          </button>
          <button className="btn btn-primary" onClick={saveProvider} disabled={update.isPending} data-testid="button-save-ai-settings">
            <Save size={15} /> {update.isPending ? t('settings.savingProvider') : t('settings.saveProvider')}
          </button>
        </div>
        <p className="text-[11px] text-[hsl(var(--muted-foreground))] mt-2">{t('settings.modelHint')}</p>

        {testResult && (
          <div
            className={`mt-4 rounded-lg px-4 py-3 text-sm font-semibold ${testResult.ok ? 'bg-[hsl(var(--primary)/.13)] text-[hsl(var(--primary))]' : 'bg-[hsl(var(--accent)/.18)] text-[hsl(12_65%_42%)]'}`}
            data-testid="status-ai-test-result"
          >
            {testResult.ok
              ? t('settings.testResultOk', { ms: testResult.latencyMs })
              : t('settings.testResultError', { error: testResult.error ?? '' })}
          </div>
        )}
      </section>

      {isSaas && <ByokSection t={t} />}
      {isSaas && <AccountSection t={t} />}

      {!isSaas && (
      <section className="surface p-6 mt-5">
        <div className="section-heading">
          <div>
            <h2>{t('settings.automationsSectionTitle')}</h2>
            <p>{t('settings.automationsSectionSubtitle')}</p>
          </div>
        </div>

        <div className="grid gap-5">
          <ToggleRow
            label={t('settings.gmailSyncLabel')}
            subtitle={t('settings.gmailSyncSubtitle')}
            checked={gmailEnabled}
            onChange={setGmailEnabled}
            testId="gmail-sync"
          />
          {gmailEnabled && (
            <div className="ml-1 pl-4 border-l-2 border-[hsl(var(--border))]">
              <ToggleRow label={t('settings.gmailSyncDryRunLabel')} checked={gmailDryRun} onChange={setGmailDryRun} testId="gmail-sync-dry-run" />
            </div>
          )}
          <ToggleRow
            label={t('settings.aiScoutLabel')}
            subtitle={t('settings.aiScoutSubtitle')}
            checked={scoutEnabled}
            onChange={setScoutEnabled}
            testId="ai-scout"
          />
          <ToggleRow
            label={t('settings.notionInboxLabel')}
            subtitle={t('settings.notionInboxSubtitle')}
            checked={notionEnabled}
            onChange={setNotionEnabled}
            testId="notion-inbox"
          />
          {notionEnabled && (
            <div className="ml-1 pl-4 border-l-2 border-[hsl(var(--border))] grid gap-3">
              <div>
                <label className="label" htmlFor="notion-page-url">
                  {t('settings.notionInboxPageUrlLabel')}
                </label>
                <input
                  id="notion-page-url"
                  className="input"
                  value={notionPageUrl}
                  onChange={(event) => setNotionPageUrl(event.target.value)}
                  data-testid="input-notion-page-url"
                />
              </div>
              <div>
                <label className="label" htmlFor="notion-data-source-url">
                  {t('settings.notionInboxDataSourceUrlLabel')}
                </label>
                <input
                  id="notion-data-source-url"
                  className="input"
                  value={notionDataSourceUrl}
                  onChange={(event) => setNotionDataSourceUrl(event.target.value)}
                  data-testid="input-notion-data-source-url"
                />
              </div>
            </div>
          )}
        </div>

        <div className="flex justify-end mt-5">
          <button className="btn btn-primary" onClick={saveAutomations} disabled={update.isPending} data-testid="button-save-automations">
            <Save size={15} /> {update.isPending ? t('settings.savingAutomations') : t('settings.saveAutomations')}
          </button>
        </div>
      </section>
      )}
    </div>
  );
}

// Exported for reuse by the onboarding wizard's BYOK step
// (pages/onboarding.tsx), which reuses this section verbatim rather than
// re-implementing the "paste, test, save" credential card.
export function ByokSection({ t }: { t: ReturnType<typeof useT> }) {
  const [locale] = useLocale();
  const credentials = useListAiCredentials();

  return (
    <section className="surface p-6 mt-5">
      <div className="section-heading">
        <div>
          <h2>{t('settings.byokSectionTitle')}</h2>
          <p>{t('settings.byokSectionSubtitle')}</p>
        </div>
      </div>

      {credentials.isLoading && <p className="text-sm text-[hsl(var(--muted-foreground))] mt-3">{t('loading.settings')}</p>}
      {credentials.isError && (
        <div className="mt-3">
          <ErrorState onRetry={() => credentials.refetch()} />
        </div>
      )}

      {credentials.data && (
        <div className="grid gap-4 mt-4">
          {credentials.data.map((credential) => (
            <ByokCredentialCard key={credential.provider} credential={credential} t={t} locale={locale} />
          ))}
        </div>
      )}
    </section>
  );
}

function ByokCredentialCard({
  credential,
  t,
  locale,
}: {
  credential: AiCredentialStatus;
  t: ReturnType<typeof useT>;
  locale: Locale;
}) {
  const queryClient = useQueryClient();
  const [apiKeyInput, setApiKeyInput] = useState('');
  const [testResult, setTestResult] = useState<AiTestResult | null>(null);

  const invalidate = () => queryClient.invalidateQueries({ queryKey: getListAiCredentialsQueryKey() });

  const save = useSaveAiCredential();
  const remove = useDeleteAiCredential();
  const test = useTestAiCredential();

  const handleSave = () => {
    const apiKey = apiKeyInput.trim();
    if (!apiKey) return;
    save.mutate(
      { provider: credential.provider, data: { apiKey } },
      {
        onSuccess: () => {
          invalidate();
          setApiKeyInput('');
          setTestResult(null);
          toast(t('settings.byokToastSaved'));
        },
        onError: () => toast(t('settings.byokToastSaveFailed')),
      },
    );
  };

  const handleTest = () => {
    setTestResult(null);
    const apiKey = apiKeyInput.trim();
    test.mutate(
      { provider: credential.provider, data: apiKey ? { apiKey } : undefined },
      {
        onSuccess: (result) => {
          setTestResult(result);
          invalidate();
          toast(result.ok ? t('settings.toastTestOk') : t('settings.toastTestFailed'));
        },
        onError: () => toast(t('settings.toastTestFailed')),
      },
    );
  };

  const handleRemove = () => {
    remove.mutate(
      { provider: credential.provider },
      {
        onSuccess: () => {
          invalidate();
          setTestResult(null);
          toast(t('settings.byokToastDeleted'));
        },
        onError: () => toast(t('settings.byokToastDeleteFailed')),
      },
    );
  };

  const canTest = apiKeyInput.trim().length > 0 || credential.configured;

  return (
    <div className="rounded-xl border border-[hsl(var(--border))] p-4" data-testid={`card-byok-${credential.provider}`}>
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 font-bold text-sm">
          <KeyRound size={15} />
          {PROVIDER_LABELS[credential.provider] ?? credential.provider}
        </div>
        <span
          className={`badge ${credential.configured ? 'badge-green' : 'badge-muted'}`}
          data-testid={`status-byok-configured-${credential.provider}`}
        >
          {credential.configured
            ? t('settings.byokConfiguredBadge', { hint: credential.hint ?? '' })
            : t('settings.byokNotConfiguredBadge')}
        </span>
      </div>

      <div className="grid gap-3 sm:grid-cols-[1fr_auto_auto] items-end mt-3">
        <div>
          <label className="label" htmlFor={`byok-key-${credential.provider}`}>
            {t('settings.byokApiKeyLabel')}
          </label>
          <input
            id={`byok-key-${credential.provider}`}
            className="input"
            type="password"
            autoComplete="off"
            value={apiKeyInput}
            onChange={(event) => setApiKeyInput(event.target.value)}
            placeholder={credential.configured ? t('settings.byokApiKeyPlaceholderConfigured') : t('settings.byokApiKeyPlaceholder')}
            data-testid={`input-byok-key-${credential.provider}`}
          />
        </div>
        <button
          className="btn btn-ghost"
          onClick={handleTest}
          disabled={test.isPending || !canTest}
          data-testid={`button-test-byok-${credential.provider}`}
        >
          <FlaskConical size={15} /> {test.isPending ? t('settings.testing') : t('settings.testButton')}
        </button>
        <button
          className="btn btn-primary"
          onClick={handleSave}
          disabled={save.isPending || !apiKeyInput.trim()}
          data-testid={`button-save-byok-${credential.provider}`}
        >
          <Save size={15} /> {save.isPending ? t('settings.byokSaving') : t('settings.byokSaveButton')}
        </button>
      </div>

      {credential.configured && (
        <button
          type="button"
          className="btn btn-ghost mt-3"
          onClick={handleRemove}
          disabled={remove.isPending}
          data-testid={`button-remove-byok-${credential.provider}`}
        >
          <Trash2 size={14} /> {remove.isPending ? t('settings.byokRemoving') : t('settings.byokRemoveButton')}
        </button>
      )}

      {(credential.lastOkAt || credential.lastError) && (
        <p className="text-[11px] text-[hsl(var(--muted-foreground))] mt-2">
          {credential.lastError
            ? t('settings.byokLastError', { error: credential.lastError })
            : credential.lastOkAt
              ? t('settings.byokLastOk', {
                  date: new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(
                    new Date(credential.lastOkAt),
                  ),
                })
              : ''}
        </p>
      )}

      {testResult && (
        <div
          className={`mt-3 rounded-lg px-3 py-2 text-xs font-semibold ${testResult.ok ? 'bg-[hsl(var(--primary)/.13)] text-[hsl(var(--primary))]' : 'bg-[hsl(var(--accent)/.18)] text-[hsl(12_65%_42%)]'}`}
          data-testid={`status-byok-test-result-${credential.provider}`}
        >
          {testResult.ok
            ? t('settings.testResultOk', { ms: testResult.latencyMs })
            : t('settings.testResultError', { error: testResult.error ?? '' })}
        </div>
      )}
    </div>
  );
}

/**
 * Data export and account deletion (SaaS mode only - docs/SAAS-ARCHITECTURE.md
 * section 8). A self-hosted owner already has full access to their own
 * database and files, so this section only ever renders in SaaS.
 */
function AccountSection({ t }: { t: ReturnType<typeof useT> }) {
  const [confirming, setConfirming] = useState(false);
  const [password, setPassword] = useState('');
  const deleteAccount = useDeleteAccount();

  const handleDelete = () => {
    deleteAccount.mutate(
      { data: { password } },
      {
        onSuccess: () => {
          // The session cookie is cleared server-side. A full reload is the
          // simplest way to make every cached query (profile, jobs...) go
          // away along with it and land back on the sign-in screen.
          window.location.href = '/';
        },
        onError: () => toast(t('settings.toastAccountDeleteFailed')),
      },
    );
  };

  return (
    <section className="surface p-6 mt-5">
      <div className="section-heading">
        <div>
          <h2>{t('settings.accountSectionTitle')}</h2>
          <p>{t('settings.accountSectionSubtitle')}</p>
        </div>
      </div>

      <div className="flex items-center justify-between gap-4 mt-4">
        <div>
          <div className="text-sm font-bold">{t('settings.exportButton')}</div>
          <p className="text-xs text-[hsl(var(--muted-foreground))] mt-0.5">{t('settings.exportHint')}</p>
        </div>
        <a
          className="btn btn-ghost"
          href={getGetAccountExportUrl()}
          download="jobblast-export.json"
          data-testid="link-export-account"
        >
          <Download size={15} /> {t('settings.exportButton')}
        </a>
      </div>

      <Link
        href="/privacy"
        className="inline-block mt-4 text-xs underline underline-offset-4 text-[hsl(var(--muted-foreground))]"
        data-testid="link-privacy-from-settings"
      >
        {t('settings.privacyLinkLabel')}
      </Link>

      <div className="rounded-xl border border-[hsl(12_65%_82%)] bg-[hsl(12_65%_97%)] p-4 mt-6">
        <div className="text-sm font-bold text-[hsl(12_65%_35%)]">{t('settings.dangerZoneTitle')}</div>
        <p className="text-xs text-[hsl(12_65%_42%)] mt-1">{t('settings.dangerZoneBody')}</p>

        {!confirming ? (
          <button
            type="button"
            className="btn btn-danger mt-3"
            onClick={() => setConfirming(true)}
            data-testid="button-delete-account"
          >
            <Trash2 size={14} /> {t('settings.deleteAccountButton')}
          </button>
        ) : (
          <div className="grid gap-3 mt-3 sm:grid-cols-[1fr_auto_auto] items-end">
            <div>
              <label className="label" htmlFor="delete-account-password">
                {t('settings.deleteAccountPasswordLabel')}
              </label>
              <input
                id="delete-account-password"
                type="password"
                autoComplete="current-password"
                className="input"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                data-testid="input-delete-account-password"
              />
            </div>
            <button
              type="button"
              className="btn btn-ghost"
              onClick={() => {
                setConfirming(false);
                setPassword('');
              }}
              data-testid="button-delete-account-cancel"
            >
              {t('settings.deleteAccountCancel')}
            </button>
            <button
              type="button"
              className="btn btn-danger"
              onClick={handleDelete}
              disabled={deleteAccount.isPending || !password}
              data-testid="button-delete-account-confirm"
            >
              <Trash2 size={14} />{' '}
              {deleteAccount.isPending ? t('settings.deleteAccountWorking') : t('settings.deleteAccountConfirmButton')}
            </button>
          </div>
        )}
      </div>
    </section>
  );
}

function ToggleRow({
  label,
  subtitle,
  checked,
  onChange,
  testId,
}: {
  label: string;
  subtitle?: string;
  checked: boolean;
  onChange: (value: boolean) => void;
  testId: string;
}) {
  return (
    <div className="flex items-center justify-between gap-4">
      <div>
        <div className="text-sm font-bold">{label}</div>
        {subtitle && <div className="text-xs text-[hsl(var(--muted-foreground))] mt-0.5">{subtitle}</div>}
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={label}
        onClick={() => onChange(!checked)}
        className={`switch ${checked ? 'switch-on' : ''}`}
        data-testid={`toggle-${testId}`}
      >
        <span className="switch-thumb" />
      </button>
    </div>
  );
}
