import { ArrowRight, Check, ChevronRight, Flame, Sparkles, Target, TrendingUp, TriangleAlert, X as XIcon } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'wouter';
import {
  getListAiCredentialsQueryKey,
  useGetAuthSession,
  useGetDashboard,
  useGetSettings,
  useListAiCredentials,
  useListAiProviderOptions,
} from '@workspace/api-client-react';
import { EmptyState, ErrorState, LoadingState } from '@/components/app-shell';
import { useLocale, useT, type TranslationKey } from '@/i18n';

const NUDGE_DISMISSED_KEY = 'jobblast.dismissedClaudeCliNudge';

function readNudgeDismissed(): boolean {
  try {
    return window.localStorage.getItem(NUDGE_DISMISSED_KEY) === '1';
  } catch {
    return false;
  }
}

function ClaudeCliNudge() {
  const t = useT();
  const settings = useGetSettings();
  const options = useListAiProviderOptions();
  const [dismissed, setDismissed] = useState(readNudgeDismissed);

  const claudeCliOption = options.data?.find((option) => option.id === 'claude-cli');
  const shouldShow = settings.data?.ai.provider === 'claude-cli' && claudeCliOption?.available === false;
  if (dismissed || !shouldShow) return null;

  const dismiss = () => {
    setDismissed(true);
    try {
      window.localStorage.setItem(NUDGE_DISMISSED_KEY, '1');
    } catch {
      // Ignore storage failures (e.g. private browsing); the dismissal still applies for this session.
    }
  };

  return (
    <div className="nudge-banner" data-testid="banner-claude-cli-nudge">
      <div className="flex items-start gap-3">
        <TriangleAlert size={18} className="text-[hsl(38_92%_38%)] mt-0.5 flex-none" />
        <div>
          <div className="font-bold text-sm">{t('dashboard.nudgeClaudeCliTitle')}</div>
          <p className="text-xs text-[hsl(var(--muted-foreground))] mt-1">{t('dashboard.nudgeClaudeCliBody')}</p>
          <Link href="/settings" className="text-xs font-bold text-[hsl(var(--primary))] mt-2 inline-flex items-center gap-1" data-testid="link-nudge-settings">
            {t('dashboard.nudgeClaudeCliCta')} <ArrowRight size={13} />
          </Link>
        </div>
      </div>
      <button
        type="button"
        className="btn btn-ghost icon-btn flex-none"
        onClick={dismiss}
        aria-label={t('common.dismiss')}
        data-testid="button-dismiss-claude-cli-nudge"
      >
        <XIcon size={15} />
      </button>
    </div>
  );
}

/**
 * "Your AI key stopped working." Saas only, and deliberately a banner rather
 * than an email: docs/SAAS-ARCHITECTURE.md open question 4 picks option (b),
 * surfacing it in the app, because a daily "your key is still broken" mail is
 * worse than useless.
 *
 * The condition is just `lastError` being set, because the server clears it
 * on the first call that succeeds again (recordCredentialTestResult): a
 * non-null error always means the most recent attempt failed.
 */
function ByokOutageBanner() {
  const t = useT();
  const session = useGetAuthSession();
  const isSaas = session.data?.mode === 'saas';
  // Selfhosted has no credential rows at all and the endpoint 404s there, so
  // the query is not even started.
  const credentials = useListAiCredentials({
    query: { queryKey: getListAiCredentialsQueryKey(), enabled: isSaas },
  });

  const broken = credentials.data?.find((credential) => credential.configured && credential.lastError);
  if (!isSaas || !broken) return null;

  return (
    <div className="nudge-banner" data-testid="banner-byok-outage">
      <div className="flex items-start gap-3">
        <TriangleAlert size={18} className="text-[hsl(38_92%_38%)] mt-0.5 flex-none" />
        <div>
          <div className="font-bold text-sm">{t('dashboard.byokOutageTitle')}</div>
          <p className="text-xs text-[hsl(var(--muted-foreground))] mt-1">{t('dashboard.byokOutageBody')}</p>
          <p className="text-xs font-mono-app text-[hsl(var(--muted-foreground))] mt-2 break-words" data-testid="text-byok-outage-error">
            {broken.lastError}
          </p>
          <Link href="/settings" className="text-xs font-bold text-[hsl(var(--primary))] mt-2 inline-flex items-center gap-1" data-testid="link-byok-outage-settings">
            {t('dashboard.byokOutageCta')} <ArrowRight size={13} />
          </Link>
        </div>
      </div>
    </div>
  );
}

/**
 * "Your first batch is on its way." G1 onboarding lot: right after
 * onboarding finishes, the review queue and this whole dashboard are
 * genuinely empty because the shared refresh this account is waiting on has
 * not landed yet - see `firstBatchPending` in routes/dashboard.ts. Without
 * this, a brand-new account sees the exact same silent empty states as an
 * account that skipped everything, with no way to tell "still loading" from
 * "nothing here".
 */
function FirstBatchBanner() {
  const t = useT();
  return (
    <div className="nudge-banner" data-testid="banner-first-batch-pending">
      <div className="flex items-start gap-3">
        <Sparkles size={18} className="text-[hsl(var(--primary))] mt-0.5 flex-none" />
        <div>
          <div className="font-bold text-sm">{t('dashboard.firstBatchTitle')}</div>
          <p className="text-xs text-[hsl(var(--muted-foreground))] mt-1">{t('dashboard.firstBatchBody')}</p>
        </div>
      </div>
    </div>
  );
}

export default function Dashboard() {
  const dashboard = useGetDashboard();
  const [locale] = useLocale();
  const t = useT();
  const formatDate = (value: string) => new Intl.DateTimeFormat(locale, { month: 'short', day: 'numeric' }).format(new Date(value));
  if (dashboard.isLoading) return <LoadingState />;
  if (dashboard.isError || !dashboard.data) return <div className="content-wrap"><ErrorState onRetry={() => dashboard.refetch()} /></div>;
  const data = dashboard.data;
  const goal = Math.min(100, data.dailyGoal ? (data.appliedToday / data.dailyGoal) * 100 : 0);
  return (
    <div className="content-wrap">
      <ClaudeCliNudge />
      <ByokOutageBanner />
      {data.firstBatchPending && <FirstBatchBanner />}
      <section className="mb-8">
        <div className="eyebrow">{t('dashboard.eyebrow')}</div>
        <div className="mt-3 flex flex-wrap items-end justify-between gap-5">
          <div><h1 className="page-title">{t('dashboard.title')}</h1><p className="page-subtitle">{t('dashboard.subtitle')}</p></div>
          <Link href="/review" className="btn btn-primary" data-testid="link-start-review">{t('dashboard.startReviewing')} <ArrowRight size={16} /></Link>
        </div>
      </section>
      <section className="stat-grid mb-7">
        <div className="surface stat-card list-enter"><div className="flex items-center justify-between"><span className="stat-label">{t('dashboard.statDailyProgress')}</span><Target size={17} className="text-[hsl(var(--primary))]" /></div><div className="stat-value">{data.appliedToday}<span className="text-lg text-[hsl(var(--muted-foreground))]"> / {data.dailyGoal}</span></div><div className="progress-track mt-4"><div className="progress-bar" style={{ width: `${goal}%` }} /></div></div>
        <div className="surface stat-card list-enter"><div className="flex items-center justify-between"><span className="stat-label">{t('dashboard.statInReviewQueue')}</span><BriefcaseIcon /></div><div className="stat-value">{data.queuedCount}</div><div className="text-xs text-[hsl(var(--primary))] mt-4 font-semibold">{t('dashboard.strongMatches', { count: data.strongMatchCount })}</div></div>
        <div className="surface stat-card list-enter"><div className="flex items-center justify-between"><span className="stat-label">{t('dashboard.statResponseRate')}</span><TrendingUp size={17} className="text-[hsl(var(--accent))]" /></div><div className="stat-value">{data.responseRate}<span className="text-lg">%</span></div><div className="text-xs text-[hsl(var(--muted-foreground))] mt-4">{t('dashboard.acrossActiveApplications')}</div></div>
        <div className="surface stat-card list-enter"><div className="flex items-center justify-between"><span className="stat-label">{t('dashboard.statSearchStreak')}</span><Flame size={17} className="text-[hsl(var(--accent))]" /></div><div className="stat-value">{data.streakDays}<span className="text-lg text-[hsl(var(--muted-foreground))]"> {t('dashboard.days')}</span></div><div className="text-xs text-[hsl(var(--muted-foreground))] mt-4">{t('dashboard.followUpsNeedNudge', { count: data.needsFollowUp })}</div></div>
      </section>
      <div className="grid gap-5 lg:grid-cols-[1.1fr_.9fr]">
        <section className="surface">
          <div className="p-5 pb-3 section-heading"><div><h2>{t('dashboard.recentApplications')}</h2><p>{t('dashboard.keepStoryMoving')}</p></div><Link href="/applications" className="text-xs font-bold text-[hsl(var(--primary))] flex items-center gap-1" data-testid="link-view-applications">{t('dashboard.viewAll')} <ChevronRight size={14} /></Link></div>
          {data.recentApplications?.length ? <div className="table-wrap"><table className="data-table"><thead><tr><th>{t('dashboard.colRole')}</th><th>{t('dashboard.colStatus')}</th><th>{t('dashboard.colApplied')}</th></tr></thead><tbody>{data.recentApplications.slice(0, 5).map((app) => <tr key={app.id} className="list-enter"><td><div className="flex items-center gap-3"><div className="avatar">{app.companyInitials}</div><div><div className="font-bold">{app.title}</div><div className="text-xs text-[hsl(var(--muted-foreground))]">{app.company} · {app.location}</div></div></div></td><td><StatusBadge status={app.status} /></td><td className="text-xs text-[hsl(var(--muted-foreground))]">{formatDate(app.appliedAt)}</td></tr>)}</tbody></table></div> : data.firstBatchPending ? <EmptyState title={t('dashboard.firstBatchEmptyTitle')} body={t('dashboard.firstBatchEmptyBody')} /> : <EmptyState title={t('dashboard.emptyTitle')} body={t('dashboard.emptyBody')} action={<Link href="/review" className="btn btn-primary" data-testid="link-empty-review">{t('dashboard.openReviewQueue')}</Link>} />}
        </section>
        <section className="surface-dark p-6 relative overflow-hidden"><div className="absolute -right-12 -top-12 h-40 w-40 rounded-full border border-[hsl(var(--sidebar-primary)/.28)]" /><div className="absolute -right-5 -top-5 h-24 w-24 rounded-full border border-[hsl(var(--sidebar-primary)/.2)]" /><div className="eyebrow text-[hsl(var(--sidebar-primary))]">{t('dashboard.funnelHealth')}</div><h2 className="text-2xl font-bold tracking-[-.05em] mt-3">{t('dashboard.smallMoves')} <span className="text-[hsl(var(--sidebar-primary))]">{t('dashboard.compounding')}</span></h2><div className="grid grid-cols-3 gap-3 mt-8"><FunnelStat value={data.interviewCount} labelKey="dashboard.interviews" /><FunnelStat value={data.offerCount} labelKey="dashboard.offers" /><FunnelStat value={data.needsFollowUp} labelKey="dashboard.followUps" /></div><div className="mt-8 pt-5 border-t border-[hsl(var(--sidebar-border))] flex items-center justify-between text-xs text-[hsl(var(--sidebar-foreground)/.65)]"><span>{t('dashboard.queueHealth')}</span><span className="font-mono-app text-[hsl(var(--sidebar-primary))]">{t('dashboard.queueReady', { count: data.queuedCount })}</span></div></section>
      </div>
    </div>
  );
}
function BriefcaseIcon() { return <span className="text-[hsl(var(--primary))] font-mono-app text-sm">Q</span>; }
function FunnelStat({ value, labelKey }: { value: number; labelKey: TranslationKey }) { const t = useT(); return <div><div className="text-3xl font-bold tracking-[-.06em]">{value}</div><div className="text-[10px] uppercase tracking-[.08em] text-[hsl(var(--sidebar-foreground)/.5)] mt-1">{t(labelKey)}</div></div>; }
function StatusBadge({ status }: { status: string }) { const t = useT(); const tone = status === 'offer' || status === 'interview' ? 'badge-green' : status === 'rejected' ? 'badge-coral' : status === 'approved' ? 'badge-amber' : 'badge-muted'; const label = t(`status.${status}` as TranslationKey); return <span className={`badge ${tone}`}>{label}</span>; }
