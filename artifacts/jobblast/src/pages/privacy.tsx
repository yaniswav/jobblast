import { getGetLegalInfoQueryKey, useGetAuthSession, useGetLegalInfo } from '@workspace/api-client-react';
import { ErrorState, LoadingState } from '@/components/app-shell';
import { useT } from '@/i18n';
import NotFound from './not-found';

function formatCap(cap: number | null, unlimitedLabel: string): string {
  return cap === null ? unlimitedLabel : String(cap);
}

/**
 * Only ever rendered in SaaS mode (docs/SAAS-ARCHITECTURE.md section 8). A
 * self-hosted install has no operator to describe - the owner already has
 * full access to their own database and files - so this page does not
 * exist there: GET /legal 404s, and this component falls back to NotFound
 * rather than showing an empty shell.
 */
export default function Privacy() {
  const t = useT();
  const session = useGetAuthSession();
  const isSaas = session.data?.mode === 'saas';
  const legal = useGetLegalInfo({ query: { enabled: isSaas, queryKey: getGetLegalInfoQueryKey() } });

  if (session.isPending) return <LoadingState label={t('privacy.title')} />;
  if (!isSaas) return <NotFound />;
  if (legal.isLoading) return <LoadingState label={t('privacy.title')} />;
  if (legal.isError || !legal.data) {
    return (
      <div className="content-wrap">
        <ErrorState onRetry={() => legal.refetch()} />
      </div>
    );
  }

  const info = legal.data;

  return (
    <div className="content-wrap">
      <section className="mb-7">
        <div className="eyebrow">{t('privacy.eyebrow')}</div>
        <div className="mt-3">
          <h1 className="page-title">{t('privacy.title')}</h1>
          <p className="page-subtitle">{t('privacy.subtitle')}</p>
        </div>
      </section>

      <section className="surface p-6 grid gap-6">
        <div>
          <h2 className="font-bold text-sm mb-1">{t('privacy.operatorHeading')}</h2>
          {info.available ? (
            <div className="text-sm text-[hsl(var(--muted-foreground))]">
              {info.operator && <p>{info.operator}</p>}
              {info.address && <p>{t('privacy.operatorAddress', { address: info.address })}</p>}
              {info.contact && <p>{t('privacy.operatorContact', { contact: info.contact })}</p>}
            </div>
          ) : (
            <p className="text-sm text-[hsl(var(--muted-foreground))]">{t('privacy.operatorMissing')}</p>
          )}
        </div>

        <div>
          <h2 className="font-bold text-sm mb-1">{t('privacy.dataHeading')}</h2>
          <p className="text-sm text-[hsl(var(--muted-foreground))]">{t('privacy.dataBody')}</p>
        </div>

        <div>
          <h2 className="font-bold text-sm mb-1">{t('privacy.purposeHeading')}</h2>
          <p className="text-sm text-[hsl(var(--muted-foreground))]">{t('privacy.purposeBody')}</p>
        </div>

        <div>
          <h2 className="font-bold text-sm mb-1">{t('privacy.byokHeading')}</h2>
          <p className="text-sm text-[hsl(var(--muted-foreground))]">{t('privacy.byokBody')}</p>
        </div>

        <div>
          <h2 className="font-bold text-sm mb-1">{t('privacy.whereHeading')}</h2>
          <p className="text-sm text-[hsl(var(--muted-foreground))]">
            {info.country
              ? t('privacy.whereBodyWithCountry', { country: info.country })
              : t('privacy.whereBodyNoCountry')}
          </p>
        </div>

        <div>
          <h2 className="font-bold text-sm mb-1">{t('privacy.retentionHeading')}</h2>
          <p className="text-sm text-[hsl(var(--muted-foreground))]">
            {t('privacy.retentionBody', { days: info.postingsRetentionDays })}
          </p>
        </div>

        <div>
          <h2 className="font-bold text-sm mb-1">{t('privacy.quotasHeading')}</h2>
          <p className="text-sm text-[hsl(var(--muted-foreground))]">
            {t('privacy.quotasBody', {
              tailor: formatCap(info.quotas.tailorPerDay, t('privacy.unlimited')),
              fit: formatCap(info.quotas.fitPerDay, t('privacy.unlimited')),
              brief: formatCap(info.quotas.briefPerDay, t('privacy.unlimited')),
            })}
          </p>
        </div>

        <div>
          <h2 className="font-bold text-sm mb-1">{t('privacy.rightsHeading')}</h2>
          <p className="text-sm text-[hsl(var(--muted-foreground))]">{t('privacy.rightsBody')}</p>
        </div>

        <div>
          <h2 className="font-bold text-sm mb-1">{t('privacy.cookiesHeading')}</h2>
          <p className="text-sm text-[hsl(var(--muted-foreground))]">{t('privacy.cookiesBody')}</p>
        </div>

        <div>
          <h2 className="font-bold text-sm mb-1">{t('privacy.inactivityHeading')}</h2>
          <p className="text-sm text-[hsl(var(--muted-foreground))]">
            {info.inactivityPurge.enabled
              ? t('privacy.inactivityBodyActive', {
                  warningMonths: info.inactivityPurge.warningAfterMonths,
                  deleteMonths: info.inactivityPurge.deleteAfterMonths,
                  graceDays: info.inactivityPurge.warningGraceDays,
                })
              : t('privacy.inactivityBodyInactive')}
          </p>
        </div>

        <div>
          <h2 className="font-bold text-sm mb-1">{t('privacy.betaHeading')}</h2>
          <p className="text-sm text-[hsl(var(--muted-foreground))]">{t('privacy.betaBody')}</p>
        </div>
      </section>
    </div>
  );
}
