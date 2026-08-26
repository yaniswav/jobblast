import { CalendarClock, Check, CircleAlert, Edit3, ExternalLink, FileDown, Filter, RefreshCw, Search, Sparkles, X } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { ApplicationStatus, getGetDashboardQueryKey, getGetInterviewBriefPdfUrl, getGetInterviewBriefQueryKey, getGetJobQueryKey, getListApplicationsQueryKey, useGetInterviewBrief, useGetJob, useListApplications, useRegenerateInterviewBrief, useUpdateApplication } from '@workspace/api-client-react';
import type { Application, ApplicationStatus as ApplicationStatusType } from '@workspace/api-client-react';
import { EmptyState, ErrorState, LoadingState } from '@/components/app-shell';
import { useLocale, useT, type TranslationKey } from '@/i18n';

const statuses = Object.values(ApplicationStatus);

/** How often an unfinished brief is re-polled while its panel is open. */
const BRIEF_POLL_MS = 15_000;

export default function Applications() {
  const t = useT();
  const [filter, setFilter] = useState<'all' | ApplicationStatusType>('all');
  const [search, setSearch] = useState('');
  const [editing, setEditing] = useState<Application | null>(null);
  const [preparing, setPreparing] = useState<Application | null>(null);
  const applications = useListApplications(filter === 'all' ? undefined : { status: filter });
  const visible = useMemo(() => (applications.data ?? []).filter((app) => `${app.title} ${app.company} ${app.location}`.toLowerCase().includes(search.toLowerCase())), [applications.data, search]);
  if (applications.isLoading) return <LoadingState label={t('loading.applications')} />;
  if (applications.isError) return <div className="content-wrap"><ErrorState onRetry={() => applications.refetch()} /></div>;
  return (
    <div className="content-wrap">
      <section className="mb-7"><div className="eyebrow">{t('applications.eyebrow')}</div><h1 className="page-title mt-3">{t('applications.title')}</h1><p className="page-subtitle">{t('applications.subtitle')}</p></section>
      <div className="surface p-3 mb-4 flex flex-wrap items-center gap-2">
        <div className="relative flex-1 min-w-[200px]"><Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-[hsl(var(--muted-foreground))]" /><input className="input pl-9" type="search" value={search} onChange={(event) => setSearch(event.target.value)} placeholder={t('applications.searchPlaceholder')} data-testid="input-search-applications" /></div>
        <div className="flex items-center gap-2 text-xs font-bold text-[hsl(var(--muted-foreground))]"><Filter size={14} /> {t('applications.filter')}</div>
        <select className="select w-auto min-w-[130px]" value={filter} onChange={(event) => setFilter(event.target.value as typeof filter)} data-testid="select-application-status"><option value="all">{t('applications.allStatuses')}</option>{statuses.map((status) => <option value={status} key={status}>{t(`status.${status}` as TranslationKey)}</option>)}</select>
      </div>
      <section className="surface">
        {visible.length ? <div className="table-wrap"><table className="data-table"><thead><tr><th>{t('applications.colRole')}</th><th>{t('applications.colStatus')}</th><th>{t('applications.colFollowUp')}</th><th>{t('applications.colNotes')}</th><th><span className="sr-only">{t('applications.colActions')}</span></th></tr></thead><tbody>{visible.map((application) => <ApplicationRow key={application.id} application={application} onEdit={() => setEditing(application)} onPrep={() => setPreparing(application)} />)}</tbody></table></div> : <EmptyState title={search ? t('applications.emptySearchTitle') : t('applications.emptyTitle')} body={search ? t('applications.emptySearchBody') : t('applications.emptyBody')} /> }
      </section>
      {editing && <EditApplication application={editing} onClose={() => setEditing(null)} />}
      {preparing && <InterviewBrief application={preparing} onClose={() => setPreparing(null)} />}
    </div>
  );
}

function ApplicationRow({ application, onEdit, onPrep }: { application: Application; onEdit: () => void; onPrep: () => void }) {
  const t = useT();
  const [locale] = useLocale();
  const isApproved = application.status === 'approved';
  const isInterview = application.status === 'interview';
  const tone = application.status === 'offer' || application.status === 'interview' ? 'badge-green' : application.status === 'rejected' ? 'badge-coral' : isApproved ? 'badge-amber' : application.status === 'applied' ? 'badge-dark' : 'badge-muted';
  const due = application.followUpDate && new Date(application.followUpDate) <= new Date();
  const queryClient = useQueryClient();
  // Only fetch the job (for its posting URL) when the row actually needs the
  // "Open listing" action — the application record itself doesn't carry a url.
  const job = useGetJob(application.jobId, { query: { enabled: isApproved, queryKey: getGetJobQueryKey(application.jobId) } });
  const markApplied = useUpdateApplication();
  const handleMarkApplied = () => markApplied.mutate({ id: application.id, data: { status: ApplicationStatus.applied } }, {
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: getListApplicationsQueryKey() });
      queryClient.invalidateQueries({ queryKey: getGetDashboardQueryKey() });
      toast(t('applications.toastMarkedApplied'));
    },
    onError: () => toast(t('applications.toastMarkAppliedFailed')),
  });
  return <tr className="list-enter" data-testid={`row-application-${application.id}`}><td><div className="flex items-center gap-3"><div className="avatar">{application.companyInitials}</div><div><div className="font-bold">{application.title}</div><div className="text-xs text-[hsl(var(--muted-foreground))] mt-1">{application.company} · {application.location}</div></div></div></td><td><span className={`badge ${tone}`}>{t(`status.${application.status}` as TranslationKey)}</span></td><td>{application.followUpDate ? <div className={`flex items-center gap-1.5 text-xs ${due ? 'text-[hsl(var(--accent))] font-bold' : 'text-[hsl(var(--muted-foreground))]'}`}><CalendarClock size={14} />{due ? t('applications.dueNow') : new Intl.DateTimeFormat(locale, { month: 'short', day: 'numeric' }).format(new Date(application.followUpDate))}</div> : <span className="text-xs text-[hsl(var(--muted-foreground))]">—</span>}</td><td><div className="max-w-[210px] truncate text-xs text-[hsl(var(--muted-foreground))]" title={application.notes}>{application.notes || t('applications.noNoteYet')}</div></td><td><div className="flex items-center justify-end gap-2">{isApproved && <a className="btn btn-ghost" href={job.data?.url} target="_blank" rel="noreferrer" aria-disabled={!job.data?.url} onClick={(event) => { if (!job.data?.url) event.preventDefault(); }} data-testid={`link-open-job-${application.id}`}><ExternalLink size={14} /> {t('applications.openListing')}</a>}{isApproved && <button className="btn btn-primary" onClick={handleMarkApplied} disabled={markApplied.isPending} data-testid={`button-mark-applied-${application.id}`}><Check size={14} /> {markApplied.isPending ? t('applications.markingApplied') : t('applications.markApplied')}</button>}{isInterview && <button className="btn btn-primary" onClick={onPrep} data-testid={`button-interview-prep-${application.id}`}><Sparkles size={14} /> {t('applications.prep')}</button>}<button className="btn btn-ghost icon-btn" onClick={onEdit} aria-label={t('applications.editAriaLabel', { title: application.title })} data-testid={`button-edit-application-${application.id}`}><Edit3 size={15} /></button></div></td></tr>;
}

// ---------------------------------------------------------------------------
// Interview prep brief
//
// The brief is researched and written by a background agent pass on the
// server (api-server/src/lib/ai/interview-brief.ts), which takes minutes, so
// this panel is a status view first and a reader second: it polls while the
// brief is pending or generating, and only ever shows content once the
// server says "ready".
// ---------------------------------------------------------------------------

type Block =
  | { kind: 'h2' | 'h3' | 'paragraph'; text: string }
  | { kind: 'bullet'; text: string }
  | { kind: 'numbered'; marker: string; text: string };

/** Strips the inline markdown this renderer does not style. */
function plain(line: string): string {
  return line
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/(^|\s)\*([^*]+)\*/g, '$1$2')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1 ($2)')
    .trim();
}

/**
 * The four constructs the brief prompt asks for (H2 sections, bullets,
 * numbered items, paragraphs). Mirrors the PDF renderer server-side, so the
 * screen and the printout agree. Not a markdown implementation.
 */
function parseBrief(markdown: string): Block[] {
  const blocks: Block[] = [];
  for (const rawLine of markdown.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || /^([-*_])\1{2,}$/.test(line)) continue;
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) { blocks.push({ kind: heading[1].length <= 2 ? 'h2' : 'h3', text: plain(heading[2]) }); continue; }
    const numbered = /^(\d+)[.)]\s+(.*)$/.exec(line);
    if (numbered) { blocks.push({ kind: 'numbered', marker: `${numbered[1]}.`, text: plain(numbered[2]) }); continue; }
    const bullet = /^[-*+]\s+(.*)$/.exec(line);
    if (bullet) { blocks.push({ kind: 'bullet', text: plain(bullet[1]) }); continue; }
    blocks.push({ kind: 'paragraph', text: plain(line) });
  }
  return blocks;
}

function BriefMarkdown({ markdown }: { markdown: string }) {
  const blocks = useMemo(() => parseBrief(markdown), [markdown]);
  return (
    <div className="text-[13px] leading-relaxed text-[hsl(var(--foreground))]">
      {blocks.map((block, index) => {
        if (block.kind === 'h2') return <h3 key={index} className="text-[15px] font-bold tracking-[-.02em] mt-6 first:mt-0 mb-2">{block.text}</h3>;
        if (block.kind === 'h3') return <h4 key={index} className="text-[13px] font-bold mt-4 mb-1.5">{block.text}</h4>;
        if (block.kind === 'bullet') return <div key={index} className="flex gap-2 mb-1.5 pl-1"><span className="text-[hsl(var(--primary))] leading-[1.6]">•</span><span>{block.text}</span></div>;
        if (block.kind === 'numbered') return <div key={index} className="flex gap-2 mb-1.5 pl-1"><span className="font-bold text-[hsl(var(--primary))] shrink-0">{block.marker}</span><span>{block.text}</span></div>;
        return <p key={index} className="mb-2.5">{block.text}</p>;
      })}
    </div>
  );
}

function InterviewBrief({ application, onClose }: { application: Application; onClose: () => void }) {
  const t = useT();
  const [locale] = useLocale();
  const queryClient = useQueryClient();
  const brief = useGetInterviewBrief(application.id, { query: { queryKey: getGetInterviewBriefQueryKey(application.id), retry: false } });
  const regenerate = useRegenerateInterviewBrief();
  const status = brief.data?.status;
  const working = status === 'pending' || status === 'generating';

  // Poll only while there is something to wait for. The panel is modal and
  // short-lived, so a plain interval beats wiring refetchInterval through the
  // generated hook's options.
  useEffect(() => {
    if (!working) return;
    const timer = window.setInterval(() => { void brief.refetch(); }, BRIEF_POLL_MS);
    return () => window.clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [working]);

  const handleRegenerate = () => regenerate.mutate({ id: application.id }, {
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: getGetInterviewBriefQueryKey(application.id) });
      toast(t('brief.toastRegenerating'));
    },
    onError: () => toast(t('brief.toastRegenerateFailed')),
  });

  return (
    <div className="fixed inset-0 z-40 grid place-items-center bg-[hsl(var(--foreground)/.38)] p-4" onClick={onClose}>
      <div className="surface w-full max-w-3xl max-h-[88vh] flex flex-col p-6 shadow-2xl" onClick={(event) => event.stopPropagation()}>
        <div className="flex items-start justify-between gap-4 mb-5">
          <div>
            <div className="eyebrow">{t('brief.eyebrow')}</div>
            <h2 className="text-xl font-bold tracking-[-.04em] mt-2">{application.company}</h2>
            <p className="text-xs text-[hsl(var(--muted-foreground))] mt-1">{application.title}</p>
          </div>
          <button className="btn btn-ghost icon-btn" onClick={onClose} aria-label={t('brief.close')} data-testid="button-close-interview-brief"><X size={17} /></button>
        </div>

        <div className="flex-1 overflow-y-auto pr-1" data-testid="interview-brief-body">
          {brief.isLoading && <LoadingState label={t('brief.loading')} />}
          {brief.isError && <ErrorState onRetry={() => brief.refetch()} />}
          {working && (
            <div className="flex items-center gap-3 rounded-xl border border-dashed border-[hsl(var(--border))] p-5 text-sm text-[hsl(var(--muted-foreground))]">
              <RefreshCw size={16} className="animate-spin text-[hsl(var(--primary))] shrink-0" />
              <div>
                <div className="font-bold text-[hsl(var(--foreground))]">{status === 'generating' ? t('brief.generating') : t('brief.pending')}</div>
                <p className="mt-1">{t('brief.waitBody')}</p>
              </div>
            </div>
          )}
          {status === 'failed' && (
            <div className="rounded-xl border border-[hsl(var(--destructive)/.28)] bg-[hsl(var(--destructive)/.06)] p-5 text-sm">
              <div className="flex items-center gap-2 font-bold"><CircleAlert size={16} /> {t('brief.failed')}</div>
              <p className="mt-2 text-xs text-[hsl(var(--muted-foreground))] whitespace-pre-wrap">{brief.data?.error || t('brief.failedUnknown')}</p>
              <button className="btn btn-primary mt-4" onClick={handleRegenerate} disabled={regenerate.isPending} data-testid="button-retry-interview-brief"><RefreshCw size={14} /> {t('brief.retry')}</button>
            </div>
          )}
          {status === 'ready' && brief.data?.contentMarkdown && <BriefMarkdown markdown={brief.data.contentMarkdown} />}
        </div>

        <div className="flex flex-wrap items-center justify-between gap-2 mt-5 pt-4 border-t border-[hsl(var(--border))]">
          <span className="text-[11px] text-[hsl(var(--muted-foreground))]">
            {status === 'ready' && brief.data?.generatedAt ? t('brief.generatedOn', { date: new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(brief.data.generatedAt)) }) : ''}
          </span>
          <div className="flex items-center gap-2">
            {status === 'ready' && <a className="btn btn-ghost" href={getGetInterviewBriefPdfUrl(application.id)} target="_blank" rel="noreferrer" data-testid="link-interview-brief-pdf"><FileDown size={14} /> {t('brief.pdf')}</a>}
            {status !== 'failed' && <button className="btn btn-ghost" onClick={handleRegenerate} disabled={regenerate.isPending || working} data-testid="button-regenerate-interview-brief"><RefreshCw size={14} /> {regenerate.isPending ? t('brief.regenerating') : t('brief.regenerate')}</button>}
          </div>
        </div>
      </div>
    </div>
  );
}

function EditApplication({ application, onClose }: { application: Application; onClose: () => void }) {
  const t = useT();
  const update = useUpdateApplication();
  const queryClient = useQueryClient();
  const [status, setStatus] = useState<ApplicationStatusType>(application.status);
  const [notes, setNotes] = useState(application.notes);
  const [followUpDate, setFollowUpDate] = useState(application.followUpDate ?? '');
  const save = () => update.mutate({ id: application.id, data: { status, notes, followUpDate: followUpDate || null } }, { onSuccess: () => { queryClient.invalidateQueries({ queryKey: getListApplicationsQueryKey() }); queryClient.invalidateQueries({ queryKey: getGetDashboardQueryKey() }); onClose(); } });
  return <div className="fixed inset-0 z-40 grid place-items-center bg-[hsl(var(--foreground)/.38)] p-4" onClick={onClose}><div className="surface w-full max-w-lg p-6 shadow-2xl" onClick={(event) => event.stopPropagation()}><div className="flex items-start justify-between gap-4 mb-6"><div><div className="eyebrow">{t('applications.updateThread')}</div><h2 className="text-xl font-bold tracking-[-.04em] mt-2">{application.title}</h2><p className="text-xs text-[hsl(var(--muted-foreground))] mt-1">{application.company}</p></div><button className="btn btn-ghost icon-btn" onClick={onClose} aria-label={t('applications.closeEditor')} data-testid="button-close-application-editor"><X size={17} /></button></div><div className="grid gap-4"><div><label className="label" htmlFor="application-status">{t('applications.status')}</label><select id="application-status" className="select" value={status} onChange={(event) => setStatus(event.target.value as ApplicationStatusType)} data-testid="select-edit-application-status">{statuses.map((value) => <option value={value} key={value}>{t(`status.${value}` as TranslationKey)}</option>)}</select></div><div><label className="label" htmlFor="follow-up-date">{t('applications.followUpDate')}</label><input id="follow-up-date" className="input" type="date" value={followUpDate} onChange={(event) => setFollowUpDate(event.target.value)} data-testid="input-follow-up-date" /></div><div><label className="label" htmlFor="application-notes">{t('applications.notes')}</label><textarea id="application-notes" className="textarea min-h-[120px]" value={notes} onChange={(event) => setNotes(event.target.value)} placeholder={t('applications.notesPlaceholder')} data-testid="textarea-application-notes" /></div></div><div className="flex justify-end gap-2 mt-6"><button className="btn btn-ghost" onClick={onClose} data-testid="button-cancel-application-edit">{t('applications.cancel')}</button><button className="btn btn-primary" onClick={save} disabled={update.isPending} data-testid="button-save-application"><Check size={15} /> {update.isPending ? t('applications.saving') : t('applications.saveChanges')}</button></div></div></div>;
}
