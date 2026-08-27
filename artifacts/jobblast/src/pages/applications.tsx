import { ArrowRightLeft, CalendarClock, CalendarPlus, Check, CircleAlert, Copy, Edit3, ExternalLink, FileDown, Filter, History, Inbox, Mail, RefreshCw, Search, Send, Sparkles, StickyNote, X } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { ApplicationStatus, getGetDashboardQueryKey, getGetFollowUpEmailQueryKey, getGetInterviewBriefPdfUrl, getGetInterviewBriefQueryKey, getGetInterviewIcsUrl, getGetJobQueryKey, getListApplicationEventsQueryKey, getListApplicationsQueryKey, useAddApplicationNote, useGetFollowUpEmail, useGetInterviewBrief, useGetJob, useListApplicationEvents, useListApplications, useMarkFollowedUp, useRegenerateInterviewBrief, useUpdateApplication } from '@workspace/api-client-react';
import type { Application, ApplicationEvent, ApplicationEventKind, ApplicationStatus as ApplicationStatusType } from '@workspace/api-client-react';
import { EmptyState, ErrorState, LoadingState } from '@/components/app-shell';
import { useLocale, useT, type TranslationKey } from '@/i18n';
import { buildGoogleCalendarUrl } from '@/lib/google-calendar';
import { relativeTime } from '@/lib/relative-time';
import { fold } from '@/lib/suggestions';

const statuses = Object.values(ApplicationStatus);

/** How often an unfinished brief is re-polled while its panel is open. */
const BRIEF_POLL_MS = 15_000;

export default function Applications() {
  const t = useT();
  const [filter, setFilter] = useState<'all' | ApplicationStatusType>('all');
  const [search, setSearch] = useState('');
  const [editing, setEditing] = useState<Application | null>(null);
  const [preparing, setPreparing] = useState<Application | null>(null);
  const [preparingFollowUp, setPreparingFollowUp] = useState<Application | null>(null);
  const [viewingHistory, setViewingHistory] = useState<Application | null>(null);
  const [scheduling, setScheduling] = useState<Application | null>(null);
  const applications = useListApplications(filter === 'all' ? undefined : { status: filter });
  // Lot H6: accent/case-insensitive (fold(), same helper the tag-editor
  // dropdowns use) so "cafe" finds "Café" and "MULLER" finds "Müller" -
  // still a plain substring filter, no dropdown here.
  const visible = useMemo(() => (applications.data ?? []).filter((app) => fold(`${app.title} ${app.company} ${app.location}`).includes(fold(search))), [applications.data, search]);
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
        {visible.length ? <div className="table-wrap"><table className="data-table"><thead><tr><th>{t('applications.colRole')}</th><th>{t('applications.colStatus')}</th><th>{t('applications.colFollowUp')}</th><th>{t('applications.colNotes')}</th><th><span className="sr-only">{t('applications.colActions')}</span></th></tr></thead><tbody>{visible.map((application) => <ApplicationRow key={application.id} application={application} onEdit={() => setEditing(application)} onPrep={() => setPreparing(application)} onPrepFollowUp={() => setPreparingFollowUp(application)} onHistory={() => setViewingHistory(application)} onSchedule={() => setScheduling(application)} />)}</tbody></table></div> : <EmptyState title={search ? t('applications.emptySearchTitle') : t('applications.emptyTitle')} body={search ? t('applications.emptySearchBody') : t('applications.emptyBody')} /> }
      </section>
      {editing && <EditApplication application={editing} onClose={() => setEditing(null)} />}
      {preparing && <InterviewBrief application={preparing} onClose={() => setPreparing(null)} />}
      {preparingFollowUp && <FollowUpPanel application={preparingFollowUp} onClose={() => setPreparingFollowUp(null)} />}
      {viewingHistory && <TimelinePanel application={viewingHistory} onClose={() => setViewingHistory(null)} />}
      {scheduling && <InterviewSchedulePanel application={scheduling} onClose={() => setScheduling(null)} onOpenBrief={() => setPreparing(scheduling)} />}
    </div>
  );
}

function ApplicationRow({ application, onEdit, onPrep, onPrepFollowUp, onHistory, onSchedule }: { application: Application; onEdit: () => void; onPrep: () => void; onPrepFollowUp: () => void; onHistory: () => void; onSchedule: () => void }) {
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
  return <tr className="list-enter" data-testid={`row-application-${application.id}`}><td><div className="flex items-center gap-3"><div className="avatar">{application.companyInitials}</div><div><div className="font-bold">{application.title}</div><div className="text-xs text-[hsl(var(--muted-foreground))] mt-1">{application.company} · {application.location}</div></div></div></td><td><div className="flex items-center gap-1.5 flex-wrap"><span className={`badge ${tone}`}>{t(`status.${application.status}` as TranslationKey)}</span>{application.followUpEligible && <span className="badge badge-amber" data-testid={`badge-follow-up-${application.id}`}>{t('applications.followUpBadge')}</span>}</div></td><td>{application.followUpDate ? <div className={`flex items-center gap-1.5 text-xs ${due ? 'text-[hsl(var(--accent))] font-bold' : 'text-[hsl(var(--muted-foreground))]'}`}><CalendarClock size={14} />{due ? t('applications.dueNow') : new Intl.DateTimeFormat(locale, { month: 'short', day: 'numeric' }).format(new Date(application.followUpDate))}</div> : <span className="text-xs text-[hsl(var(--muted-foreground))]">—</span>}</td><td><div className="max-w-[210px] truncate text-xs text-[hsl(var(--muted-foreground))]" title={application.notes}>{application.notes || t('applications.noNoteYet')}</div></td><td><div className="flex items-center justify-end gap-2">{isApproved && <a className="btn btn-ghost" href={job.data?.url} target="_blank" rel="noreferrer" aria-disabled={!job.data?.url} onClick={(event) => { if (!job.data?.url) event.preventDefault(); }} data-testid={`link-open-job-${application.id}`}><ExternalLink size={14} /> {t('applications.openListing')}</a>}{isApproved && <button className="btn btn-primary" onClick={handleMarkApplied} disabled={markApplied.isPending} data-testid={`button-mark-applied-${application.id}`}><Check size={14} /> {markApplied.isPending ? t('applications.markingApplied') : t('applications.markApplied')}</button>}{isInterview && <button className="btn btn-primary" onClick={onPrep} data-testid={`button-interview-prep-${application.id}`}><Sparkles size={14} /> {t('applications.prep')}</button>}{isInterview && <button className="btn btn-ghost" onClick={onSchedule} aria-label={t('interview.scheduleAriaLabel', { title: application.title })} data-testid={`button-schedule-interview-${application.id}`}><CalendarPlus size={14} /> {application.interviewAt ? new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(application.interviewAt)) : t('interview.scheduleButton')}</button>}{application.followUpEligible && <button className="btn btn-primary" onClick={onPrepFollowUp} data-testid={`button-prepare-follow-up-${application.id}`}><Mail size={14} /> {t('applications.prepareFollowUp')}</button>}<button className="btn btn-ghost icon-btn" onClick={onHistory} aria-label={t('timeline.openAriaLabel', { title: application.title })} data-testid={`button-history-${application.id}`}><History size={15} /></button><button className="btn btn-ghost icon-btn" onClick={onEdit} aria-label={t('applications.editAriaLabel', { title: application.title })} data-testid={`button-edit-application-${application.id}`}><Edit3 size={15} /></button></div></td></tr>;
}

// ---------------------------------------------------------------------------
// Timeline (lot I1): everything recorded for one application, newest first -
// applied, status changes (manual or detected by the Gmail sync), confirmed
// follow-ups, personal notes, detected e-mails and generated interview
// briefs. A note field at the bottom appends a new personal note; notes are
// append-only in this lot, no edit or delete.
// ---------------------------------------------------------------------------

const MAX_TIMELINE_NOTE_CHARS = 2000;

const EVENT_ICON_BY_KIND = {
  applied: Send,
  status_changed: ArrowRightLeft,
  followed_up: Mail,
  note_added: StickyNote,
  email_detected: Inbox,
  brief_generated: Sparkles,
  interview_scheduled: CalendarPlus,
} satisfies Record<ApplicationEventKind, typeof History>;

function payloadText(payload: Record<string, unknown>, key: string): string | undefined {
  const value = payload[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/** What one timeline entry shows: a title, and an optional supporting line (an e-mail subject, a note's text, ...). */
type EventDescription = { title: string; detail?: string };

/** Fully localized { title, detail } for one timeline event. */
function describeEvent(event: ApplicationEvent, t: ReturnType<typeof useT>, locale: string): EventDescription {
  const payload = event.payload as Record<string, unknown>;
  switch (event.kind) {
    case 'applied':
      return { title: t('timeline.kindApplied') };
    case 'status_changed': {
      const from = payloadText(payload, 'from');
      const to = payloadText(payload, 'to');
      const fromLabel = from ? t(`status.${from}` as TranslationKey) : '';
      const toLabel = to ? t(`status.${to}` as TranslationKey) : '';
      const title = payload['origin'] === 'gmail'
        ? t('timeline.kindStatusChangedGmail', { from: fromLabel, to: toLabel })
        : t('timeline.kindStatusChangedManual', { from: fromLabel, to: toLabel });
      return { title, detail: payloadText(payload, 'subject') };
    }
    case 'followed_up':
      return { title: t('timeline.kindFollowedUp') };
    case 'note_added':
      return { title: t('timeline.kindNoteAdded'), detail: payloadText(payload, 'text') };
    case 'email_detected':
      return { title: t('timeline.kindEmailDetected'), detail: payloadText(payload, 'subject') };
    case 'brief_generated':
      return { title: t('timeline.kindBriefGenerated') };
    case 'interview_scheduled': {
      const interviewAt = payloadText(payload, 'interviewAt');
      if (!interviewAt) return { title: t('timeline.kindInterviewCleared') };
      const date = new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(interviewAt));
      return { title: t('timeline.kindInterviewScheduled', { date }) };
    }
    default:
      return { title: event.kind };
  }
}

function TimelinePanel({ application, onClose }: { application: Application; onClose: () => void }) {
  const t = useT();
  const [locale] = useLocale();
  const queryClient = useQueryClient();
  const [note, setNote] = useState('');
  const events = useListApplicationEvents(application.id, { query: { queryKey: getListApplicationEventsQueryKey(application.id) } });
  const addNote = useAddApplicationNote();

  const trimmedNote = note.trim();
  const noteValid = trimmedNote.length > 0 && trimmedNote.length <= MAX_TIMELINE_NOTE_CHARS;

  const handleAddNote = () => {
    if (!noteValid) return;
    addNote.mutate({ id: application.id, data: { text: trimmedNote } }, {
      onSuccess: () => {
        setNote('');
        queryClient.invalidateQueries({ queryKey: getListApplicationEventsQueryKey(application.id) });
        toast(t('timeline.toastNoteAdded'));
      },
      onError: () => toast(t('timeline.toastNoteFailed')),
    });
  };

  return (
    <div className="fixed inset-0 z-40 grid place-items-center bg-[hsl(var(--foreground)/.38)] p-4" onClick={onClose}>
      <div className="surface w-full max-w-2xl max-h-[88vh] flex flex-col p-6 shadow-2xl" onClick={(event) => event.stopPropagation()}>
        <div className="flex items-start justify-between gap-4 mb-5">
          <div>
            <div className="eyebrow">{t('timeline.eyebrow')}</div>
            <h2 className="text-xl font-bold tracking-[-.04em] mt-2">{application.company}</h2>
            <p className="text-xs text-[hsl(var(--muted-foreground))] mt-1">{application.title}</p>
          </div>
          <button className="btn btn-ghost icon-btn" onClick={onClose} aria-label={t('timeline.close')} data-testid="button-close-timeline"><X size={17} /></button>
        </div>

        <div className="flex-1 overflow-y-auto pr-1" data-testid="timeline-body">
          {events.isLoading && <LoadingState label={t('timeline.loading')} />}
          {events.isError && <ErrorState onRetry={() => events.refetch()} />}
          {events.data && events.data.length === 0 && <EmptyState title={t('timeline.emptyTitle')} body={t('timeline.emptyBody')} />}
          {events.data && events.data.length > 0 && (
            <ol className="grid gap-0" data-testid="timeline-list">
              {events.data.map((event, index) => {
                const Icon = EVENT_ICON_BY_KIND[event.kind];
                const { title, detail } = describeEvent(event, t, locale);
                const occurredAt = new Date(event.occurredAt);
                const isLast = index === events.data!.length - 1;
                return (
                  <li key={event.id} className="list-enter relative pl-9" style={{ paddingBottom: isLast ? 0 : 20 }} data-testid={`timeline-event-${event.id}`}>
                    <span className="absolute left-0 top-0.5 grid h-6 w-6 place-items-center rounded-full bg-[hsl(var(--primary)/.14)] text-[hsl(var(--primary))]" aria-hidden="true"><Icon size={13} /></span>
                    {!isLast && <span className="absolute left-[11px] top-6 bottom-0 w-px bg-[hsl(var(--border))]" aria-hidden="true" />}
                    <div className="text-sm font-bold text-[hsl(var(--foreground))]">{title}</div>
                    {detail && <div className="mt-0.5 text-xs text-[hsl(var(--muted-foreground))] whitespace-pre-wrap">{detail}</div>}
                    <div
                      className="mt-1 text-[11px] text-[hsl(var(--muted-foreground))]"
                      title={new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(occurredAt)}
                    >
                      {relativeTime(occurredAt, locale)}
                    </div>
                  </li>
                );
              })}
            </ol>
          )}
        </div>

        <div className="pt-4 mt-4 border-t border-[hsl(var(--border))]">
          <label className="label" htmlFor="timeline-note">{t('timeline.noteLabel')}</label>
          <textarea
            id="timeline-note"
            className="textarea min-h-[70px]"
            value={note}
            onChange={(event) => setNote(event.target.value)}
            placeholder={t('timeline.notePlaceholder')}
            maxLength={MAX_TIMELINE_NOTE_CHARS}
            data-testid="textarea-timeline-note"
          />
          <div className="flex items-center justify-between mt-2">
            <span className="font-mono-app text-[10px] text-[hsl(var(--muted-foreground))]">{t('common.charsCount', { count: note.length })}</span>
            <button className="btn btn-primary" onClick={handleAddNote} disabled={!noteValid || addNote.isPending} data-testid="button-add-timeline-note">
              <StickyNote size={14} /> {addNote.isPending ? t('timeline.noteSaving') : t('timeline.noteButton')}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
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

// ---------------------------------------------------------------------------
// Interview scheduling (lot I2)
//
// The date/time is stored server-side (UTC, via PATCH /applications/:id)
// and this panel offers two one-click ways to get it onto a real calendar:
// a downloadable .ics (api-server/src/lib/ics.ts, RFC 5545) and a prefilled
// Google Calendar link built entirely client-side (@/lib/google-calendar,
// no OAuth). Neither ever carries the interview brief's content - only
// role, company, location and time, plus a one-line mention that a brief
// exists.
// ---------------------------------------------------------------------------

/** `<input type="datetime-local">` expects local wall-clock time with no timezone designator. */
function toDatetimeLocalValue(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function InterviewSchedulePanel({ application, onClose, onOpenBrief }: { application: Application; onClose: () => void; onOpenBrief: () => void }) {
  const t = useT();
  const [locale] = useLocale();
  const queryClient = useQueryClient();
  const update = useUpdateApplication();
  const interviewDate = application.interviewAt ? new Date(application.interviewAt) : null;
  const [value, setValue] = useState(() => (interviewDate ? toDatetimeLocalValue(interviewDate) : ''));

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: getListApplicationsQueryKey() });
    queryClient.invalidateQueries({ queryKey: getGetDashboardQueryKey() });
  };

  const handleSave = () => {
    if (!value) return;
    // datetime-local carries no timezone - `new Date(value)` reads it as the
    // browser's local time, and toISOString() converts that to UTC, which
    // is exactly what the server stores.
    const interviewAt = new Date(value).toISOString();
    update.mutate({ id: application.id, data: { interviewAt } }, {
      onSuccess: () => { invalidate(); toast(t('interview.toastSaved')); },
      onError: () => toast(t('interview.toastSaveFailed')),
    });
  };

  const handleClear = () => {
    update.mutate({ id: application.id, data: { interviewAt: null } }, {
      onSuccess: () => { invalidate(); setValue(''); toast(t('interview.toastCleared')); },
      onError: () => toast(t('interview.toastClearFailed')),
    });
  };

  const googleCalendarHref = interviewDate
    ? buildGoogleCalendarUrl({
      text: t('interview.icsSummary', { title: application.title, company: application.company }),
      location: application.location,
      start: interviewDate,
    })
    : undefined;

  return (
    <div className="fixed inset-0 z-40 grid place-items-center bg-[hsl(var(--foreground)/.38)] p-4" onClick={onClose}>
      <div className="surface w-full max-w-lg p-6 shadow-2xl" onClick={(event) => event.stopPropagation()}>
        <div className="flex items-start justify-between gap-4 mb-6">
          <div>
            <div className="eyebrow">{t('interview.eyebrow')}</div>
            <h2 className="text-xl font-bold tracking-[-.04em] mt-2">{application.company}</h2>
            <p className="text-xs text-[hsl(var(--muted-foreground))] mt-1">{application.title}</p>
          </div>
          <button className="btn btn-ghost icon-btn" onClick={onClose} aria-label={t('interview.close')} data-testid="button-close-interview-schedule"><X size={17} /></button>
        </div>

        <div className="grid gap-4">
          <div>
            <label className="label" htmlFor="interview-at">{t('interview.dateLabel')}</label>
            <input id="interview-at" className="input" type="datetime-local" value={value} onChange={(event) => setValue(event.target.value)} data-testid="input-interview-at" />
          </div>
          <div className="flex flex-wrap gap-2">
            <button className="btn btn-primary" onClick={handleSave} disabled={!value || update.isPending} data-testid="button-save-interview-at">
              <Check size={14} /> {update.isPending ? t('interview.saving') : t('interview.save')}
            </button>
            {interviewDate && <button className="btn btn-ghost" onClick={handleClear} disabled={update.isPending} data-testid="button-clear-interview-at">{t('interview.clear')}</button>}
          </div>

          {interviewDate && (
            <div className="pt-4 border-t border-[hsl(var(--border))] grid gap-3">
              <div className="text-sm font-bold" data-testid="text-interview-at">
                {new Intl.DateTimeFormat(locale, { dateStyle: 'full', timeStyle: 'short' }).format(interviewDate)}
              </div>
              <div className="flex flex-wrap gap-2">
                <a className="btn btn-ghost" href={getGetInterviewIcsUrl(application.id)} download data-testid="link-download-ics"><FileDown size={14} /> {t('interview.downloadIcs')}</a>
                <a className="btn btn-ghost" href={googleCalendarHref} target="_blank" rel="noreferrer" data-testid="link-google-calendar"><ExternalLink size={14} /> {t('interview.googleCalendar')}</a>
                <button className="btn btn-ghost" onClick={() => { onOpenBrief(); onClose(); }} data-testid="button-open-brief-from-interview"><Sparkles size={14} /> {t('interview.viewBrief')}</button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Follow-up e-mail (lot H4)
//
// JobBlast never sends this e-mail: the server only ever drafts subject +
// body text (api-server/src/lib/ai/follow-up.ts). The user copies it, or
// opens it in their own mail client via a mailto: link, and sends it
// themselves - "✓ I followed up" only records that they did.
// ---------------------------------------------------------------------------

function FollowUpPanel({ application, onClose }: { application: Application; onClose: () => void }) {
  const t = useT();
  const queryClient = useQueryClient();
  const followUp = useGetFollowUpEmail(application.id, { query: { queryKey: getGetFollowUpEmailQueryKey(application.id), retry: false } });
  const markFollowedUp = useMarkFollowedUp();

  const handleCopy = async () => {
    if (!followUp.data) return;
    try {
      await navigator.clipboard.writeText(`${followUp.data.subject}\n\n${followUp.data.body}`);
      toast(t('followUp.toastCopied'));
    } catch {
      toast(t('followUp.toastCopyFailed'));
    }
  };

  const mailtoHref = followUp.data
    ? `mailto:?subject=${encodeURIComponent(followUp.data.subject)}&body=${encodeURIComponent(followUp.data.body)}`
    : undefined;

  const handleMarkFollowedUp = () => markFollowedUp.mutate({ id: application.id }, {
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: getListApplicationsQueryKey() });
      queryClient.invalidateQueries({ queryKey: getGetDashboardQueryKey() });
      toast(t('followUp.toastMarked'));
      onClose();
    },
    onError: () => toast(t('followUp.toastMarkFailed')),
  });

  return (
    <div className="fixed inset-0 z-40 grid place-items-center bg-[hsl(var(--foreground)/.38)] p-4" onClick={onClose}>
      <div className="surface w-full max-w-2xl max-h-[88vh] flex flex-col p-6 shadow-2xl" onClick={(event) => event.stopPropagation()}>
        <div className="flex items-start justify-between gap-4 mb-5">
          <div>
            <div className="eyebrow">{t('followUp.eyebrow')}</div>
            <h2 className="text-xl font-bold tracking-[-.04em] mt-2">{application.company}</h2>
            <p className="text-xs text-[hsl(var(--muted-foreground))] mt-1">{application.title}</p>
          </div>
          <button className="btn btn-ghost icon-btn" onClick={onClose} aria-label={t('followUp.close')} data-testid="button-close-follow-up"><X size={17} /></button>
        </div>

        <div className="flex-1 overflow-y-auto pr-1" data-testid="follow-up-body">
          {followUp.isLoading && <LoadingState label={t('followUp.loading')} />}
          {followUp.isError && <ErrorState onRetry={() => followUp.refetch()} />}
          {followUp.data && (
            <div className="grid gap-4">
              <div>
                <div className="label">{t('followUp.subjectLabel')}</div>
                <div className="input" data-testid="text-follow-up-subject">{followUp.data.subject}</div>
              </div>
              <div>
                <div className="label">{t('followUp.bodyLabel')}</div>
                <div className="textarea min-h-[220px] whitespace-pre-wrap text-[13px] leading-relaxed" data-testid="text-follow-up-body">{followUp.data.body}</div>
              </div>
              {followUp.data.source === 'template' && <p className="text-xs text-[hsl(var(--muted-foreground))]">{t('followUp.templateNote')}</p>}
            </div>
          )}
        </div>

        <div className="flex flex-wrap items-center justify-end gap-2 mt-5 pt-4 border-t border-[hsl(var(--border))]">
          <button className="btn btn-ghost" onClick={handleCopy} disabled={!followUp.data} data-testid="button-copy-follow-up"><Copy size={14} /> {t('followUp.copy')}</button>
          <a className="btn btn-ghost" href={mailtoHref} aria-disabled={!mailtoHref} onClick={(event) => { if (!mailtoHref) event.preventDefault(); }} data-testid="link-mailto-follow-up"><Mail size={14} /> {t('followUp.openInMail')}</a>
          <button className="btn btn-primary" onClick={handleMarkFollowedUp} disabled={markFollowedUp.isPending || !followUp.data} data-testid="button-mark-followed-up"><Check size={14} /> {markFollowedUp.isPending ? t('followUp.marking') : t('followUp.markFollowedUp')}</button>
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
