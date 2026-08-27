import { useGetCampaignStats } from '@workspace/api-client-react';
import type { CampaignFunnel, CampaignResumeStat, CampaignSourceStat, CampaignWeeklyTrendPoint } from '@workspace/api-client-react';
import { EmptyState, ErrorState, LoadingState } from '@/components/app-shell';
import { useLocale, useT, type TranslationKey } from '@/i18n';

/** Funnel stages in display order, each paired with its translation key. */
const FUNNEL_STAGES: { key: keyof CampaignFunnel; labelKey: TranslationKey }[] = [
  { key: 'toSend', labelKey: 'stats.funnelToSend' },
  { key: 'sent', labelKey: 'stats.funnelSent' },
  { key: 'responded', labelKey: 'stats.funnelResponded' },
  { key: 'interview', labelKey: 'stats.funnelInterview' },
  { key: 'offer', labelKey: 'stats.funnelOffer' },
  { key: 'rejected', labelKey: 'stats.funnelRejected' },
];

export default function Stats() {
  const t = useT();
  const stats = useGetCampaignStats();
  if (stats.isLoading) return <LoadingState label={t('loading.workspace')} />;
  if (stats.isError || !stats.data) return <div className="content-wrap"><ErrorState onRetry={() => stats.refetch()} /></div>;
  const data = stats.data;
  const totalTracked = data.funnel.toSend + data.funnel.sent;

  return (
    <div className="content-wrap">
      <section className="mb-7">
        <div className="eyebrow">{t('stats.eyebrow')}</div>
        <h1 className="page-title mt-3">{t('stats.title')}</h1>
        <p className="page-subtitle">{t('stats.subtitle')}</p>
      </section>

      {totalTracked === 0 ? (
        <section className="surface" data-testid="stats-empty-state">
          <EmptyState title={t('stats.emptyTitle')} body={t('stats.emptyBody')} />
        </section>
      ) : (
        <div className="stats-grid">
          <FunnelCard funnel={data.funnel} />
          <div className="grid gap-4 lg:grid-cols-2">
            <BySourceCard bySource={data.bySource} />
            <TrendCard weeklyTrend={data.weeklyTrend} />
          </div>
          <div className="grid gap-4 lg:grid-cols-2">
            <DelayCard averageResponseDelayDays={data.averageResponseDelayDays} sampleSize={data.responseDelaySampleSize} />
            {data.byResume && <ByResumeCard byResume={data.byResume} />}
          </div>
        </div>
      )}
    </div>
  );
}

function FunnelCard({ funnel }: { funnel: CampaignFunnel }) {
  const t = useT();
  const max = Math.max(1, ...FUNNEL_STAGES.map((stage) => funnel[stage.key]));
  return (
    <section className="surface p-5" data-testid="card-funnel">
      <div className="section-heading"><div><h2>{t('stats.funnelTitle')}</h2><p>{t('stats.funnelSubtitle')}</p></div></div>
      <div>
        {FUNNEL_STAGES.map((stage) => {
          const value = funnel[stage.key];
          const width = (value / max) * 100;
          return (
            <div className="funnel-row" key={stage.key} data-testid={`funnel-row-${stage.key}`}>
              <span className="funnel-label">{t(stage.labelKey)}</span>
              <div className="progress-track"><div className="progress-bar" style={{ width: `${width}%` }} /></div>
              <span className="funnel-value">{value}</span>
            </div>
          );
        })}
      </div>
    </section>
  );
}

function BySourceCard({ bySource }: { bySource: CampaignSourceStat[] }) {
  const t = useT();
  return (
    <section className="surface" data-testid="card-by-source">
      <div className="p-5 pb-3 section-heading"><div><h2>{t('stats.bySourceTitle')}</h2><p>{t('stats.bySourceSubtitle')}</p></div></div>
      {bySource.length ? (
        <div className="table-wrap">
          <table className="data-table">
            <thead><tr><th>{t('stats.colSource')}</th><th>{t('stats.colSent')}</th><th>{t('stats.colResponded')}</th><th>{t('stats.colRate')}</th></tr></thead>
            <tbody>
              {bySource.map((row) => (
                <tr key={row.source} data-testid={`row-source-${row.source}`}>
                  <td className="font-bold">{row.source}</td>
                  <td>{row.sent}</td>
                  <td>{row.responded}</td>
                  <td className="font-mono-app font-bold text-[hsl(var(--primary))]">{row.responseRate}%</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="px-5 pb-5"><p className="text-sm text-[hsl(var(--muted-foreground))]" data-testid="text-by-source-empty">{t('stats.bySourceEmpty')}</p></div>
      )}
    </section>
  );
}

function TrendCard({ weeklyTrend }: { weeklyTrend: CampaignWeeklyTrendPoint[] }) {
  const t = useT();
  const [locale] = useLocale();
  const max = Math.max(1, ...weeklyTrend.map((point) => point.count));
  const total = weeklyTrend.reduce((sum, point) => sum + point.count, 0);
  // The server response coerces this "format: date" field through zod like every other date field in
  // this API (see e.g. Application.followUpDate) - it always arrives as a full ISO timestamp on the wire,
  // never a bare YYYY-MM-DD, so it is parsed directly rather than having a time suffix appended to it.
  const formatWeek = (value: string) => new Intl.DateTimeFormat(locale, { month: 'short', day: 'numeric', timeZone: 'UTC' }).format(new Date(value));
  return (
    <section className="surface p-5" data-testid="card-trend">
      <div className="section-heading"><div><h2>{t('stats.trendTitle')}</h2><p>{t('stats.trendSubtitle')}</p></div></div>
      <div className="trend-chart" data-testid="trend-chart">
        {weeklyTrend.map((point) => (
          <div className="trend-bar" key={point.weekStart} data-testid={`trend-bar-${point.weekStart}`}>
            <span className="trend-bar-count">{point.count}</span>
            <div className="trend-bar-track"><div className="trend-bar-fill" style={{ height: `${(point.count / max) * 100}%` }} /></div>
            <span className="trend-bar-label">{formatWeek(point.weekStart)}</span>
          </div>
        ))}
      </div>
      {total === 0 && <p className="text-xs text-[hsl(var(--muted-foreground))] mt-4" data-testid="text-trend-empty">{t('stats.trendEmpty')}</p>}
    </section>
  );
}

function DelayCard({ averageResponseDelayDays, sampleSize }: { averageResponseDelayDays: number | null; sampleSize: number }) {
  const t = useT();
  return (
    <section className="surface p-5" data-testid="card-delay">
      <div className="section-heading"><div><h2>{t('stats.delayTitle')}</h2><p>{t('stats.delaySubtitle')}</p></div></div>
      {averageResponseDelayDays === null ? (
        <p className="text-sm text-[hsl(var(--muted-foreground))]" data-testid="text-delay-empty">{t('stats.delayEmpty')}</p>
      ) : (
        <div>
          <div className="stat-value" data-testid="text-delay-value">{t('stats.delayDays', { count: averageResponseDelayDays })}</div>
          <div className="text-xs text-[hsl(var(--muted-foreground))] mt-3">{t('stats.delaySampleSize', { count: sampleSize })}</div>
        </div>
      )}
    </section>
  );
}

function ByResumeCard({ byResume }: { byResume: CampaignResumeStat[] }) {
  const t = useT();
  return (
    <section className="surface" data-testid="card-by-resume">
      <div className="p-5 pb-3 section-heading"><div><h2>{t('stats.byResumeTitle')}</h2><p>{t('stats.byResumeSubtitle')}</p></div></div>
      <div className="table-wrap">
        <table className="data-table">
          <thead><tr><th>{t('stats.colResume')}</th><th>{t('stats.colSent')}</th><th>{t('stats.colResponded')}</th><th>{t('stats.colInterviews')}</th></tr></thead>
          <tbody>
            {byResume.map((row) => (
              <tr key={row.resumeVersion} data-testid={`row-resume-${row.resumeVersion}`}>
                <td className="font-bold">{row.resumeVersion}</td>
                <td>{row.sent}</td>
                <td>{row.responded}</td>
                <td>{row.interviews}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
