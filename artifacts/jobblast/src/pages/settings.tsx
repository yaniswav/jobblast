import { FlaskConical, Save } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import {
  getGetSettingsQueryKey,
  useGetSettings,
  useListAiProviderOptions,
  useTestAiProvider,
  useUpdateSettings,
  type AiProviderId,
  type AiTestResult,
} from '@workspace/api-client-react';
import { ErrorState, LoadingState } from '@/components/app-shell';
import { useT } from '@/i18n';

// Cosmetic only - purely presentational labels for known provider ids. An id
// the backend returns that isn't in this map still renders fine (falls back
// to the raw id): the wizard is capability-driven, it never assumes which
// providers exist, it only dresses up the ones it happens to recognize.
const PROVIDER_LABELS: Record<string, string> = {
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
    </div>
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
