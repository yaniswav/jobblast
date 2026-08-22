import { ArrowUpRight, Check, ChevronLeft, ChevronRight, ExternalLink, FileDown, FileText, MapPin, Pause, RefreshCw, SkipForward, Sparkles, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { useCreateApplication, useGetJob, useListJobs, useRefreshJobs, useSkipJob, getGetDashboardQueryKey, getListJobsQueryKey, getGetJobQueryKey, getGetDocumentFileUrl, getGetJobCoverLetterPdfUrl } from '@workspace/api-client-react';
import { Link } from 'wouter';
import { EmptyState, ErrorState, LoadingState } from '@/components/app-shell';
import { useT } from '@/i18n';

export default function Review() {
  const t = useT();
  const jobs = useListJobs({ status: 'queued' });
  const [index, setIndex] = useState(0);
  const [letter, setLetter] = useState('');
  const [notice, setNotice] = useState('');
  const currentId = jobs.data?.[index]?.id;
  const job = useGetJob(currentId ?? 0, { query: { enabled: !!currentId, queryKey: getGetJobQueryKey(currentId ?? 0) } });
  const skip = useSkipJob();
  const create = useCreateApplication();
  const refresh = useRefreshJobs();
  const queryClient = useQueryClient();
  useEffect(() => { if (job.data) setLetter(job.data.coverLetter); }, [job.data?.id]);
  const handleRefresh = () => refresh.mutate(undefined, {
    onSuccess: (result) => {
      toast(result.started ? t('review.toastRefreshStarted') : t('review.toastRefreshAlready'));
      queryClient.invalidateQueries({ queryKey: getListJobsQueryKey({ status: 'queued' }) });
    },
    onError: () => toast(t('review.toastRefreshFailed')),
  });
  if (jobs.isLoading) return <LoadingState label={t('loading.reviewQueue')} />;
  if (jobs.isError) return <div className="content-wrap"><ErrorState onRetry={() => jobs.refetch()} /></div>;
  if (!jobs.data?.length) return <div className="content-wrap"><section className="surface"><EmptyState title={t('review.queueClearTitle')} body={t('review.queueClearBody')} action={<div className="flex items-center justify-center gap-2"><Link href="/" className="btn btn-primary" data-testid="link-back-overview">{t('review.backToOverview')}</Link><button className="btn btn-ghost" onClick={handleRefresh} disabled={refresh.isPending} data-testid="button-refresh-jobs"><RefreshCw size={15} className={refresh.isPending ? 'animate-spin' : ''} /> {t('review.refresh')}</button></div>} /></section></div>;
  const listing = job.data;
  if (job.isLoading || !listing) return <LoadingState label={t('loading.preparingMatch')} />;
  const moveNext = (message: string) => { setNotice(message); window.setTimeout(() => setNotice(''), 1800); setIndex((value) => Math.min(value + 1, (jobs.data?.length ?? 1) - 1)); };
  const handleSkip = () => skip.mutate({ id: listing.id }, { onSuccess: () => { queryClient.invalidateQueries({ queryKey: getListJobsQueryKey({ status: 'queued' }) }); moveNext(t('review.toastSkipped')); } });
  const handleApprove = () => create.mutate({ data: { jobId: listing.id, resumeVersion: 'Targeted master resume', coverLetterVersion: letter, notes: '' } }, { onSuccess: () => {
    queryClient.invalidateQueries({ queryKey: getListJobsQueryKey({ status: 'queued' }) });
    queryClient.invalidateQueries({ queryKey: getGetDashboardQueryKey() });
    // Approving only prepares the application — nothing is submitted on the
    // user's behalf, so send them straight to the employer's posting and
    // make the tracker's follow-up step explicit.
    window.open(listing.url, '_blank', 'noopener,noreferrer');
    moveNext(t('review.toastApproved'));
  } });
  return (
    <div className="content-wrap">
      <div className="flex items-end justify-between gap-4 mb-6"><div><div className="eyebrow">{t('review.eyebrow')}</div><h1 className="page-title mt-3">{t('review.title')}</h1><p className="page-subtitle">{t('review.subtitle')}</p></div><div className="flex items-center gap-4"><button className="btn btn-ghost" onClick={handleRefresh} disabled={refresh.isPending} data-testid="button-refresh-jobs"><RefreshCw size={15} className={refresh.isPending ? 'animate-spin' : ''} /> {t('review.refresh')}</button><div className="text-right"><div className="font-mono-app text-sm font-bold">{String(index + 1).padStart(2, '0')} <span className="text-[hsl(var(--muted-foreground))]">/ {String(jobs.data.length).padStart(2, '0')}</span></div><div className="text-[10px] text-[hsl(var(--muted-foreground))] uppercase tracking-[.08em] mt-1">{t('review.queued')}</div></div></div></div>
      {notice && <div className="mb-4 rounded-lg bg-[hsl(var(--primary)/.13)] px-4 py-3 text-sm font-semibold text-[hsl(var(--primary))] flash-approve" data-testid="status-review-notice">{notice}</div>}
      <div className="queue-layout">
        <article className="surface job-card">
          <div className="flex items-start justify-between gap-4"><div className="flex items-center gap-3"><div className="avatar avatar-lg">{listing.companyInitials}</div><div><div className="font-bold">{listing.company}</div><div className="flex items-center gap-2 text-xs text-[hsl(var(--muted-foreground))] mt-1"><span>{listing.source} · {t('review.postedOn', { date: listing.postedDate })}</span><span className={`badge ${listing.aiGenerated ? 'badge-green' : 'badge-muted'}`}>{listing.aiGenerated ? t('review.aiLetter') : t('review.templateDraft')}</span></div></div></div><div className="score-ring" aria-label={t('review.matchPercent', { score: listing.relevanceScore })}><span>{listing.relevanceScore}</span></div></div>
          <h2>{listing.title}</h2><div className="flex flex-wrap items-center gap-2 text-xs text-[hsl(var(--muted-foreground))]"><span className="flex items-center gap-1"><MapPin size={13} />{listing.location}</span><span>·</span><span>{listing.workMode}</span><span>·</span><span>{listing.salaryRange}</span></div>
          <div className="flex flex-wrap gap-2 mt-5">{listing.highlightedSkills?.map((skill) => <span key={skill} className="tag">{skill}</span>)}</div>
          <div className="mt-7 border-t border-[hsl(var(--border))] pt-5"><div className="flex items-center gap-2 font-bold text-sm"><Sparkles size={15} className="text-[hsl(var(--accent))]" /> {t('review.whyThisSurfaced')}</div><ul className="bullet-list">{listing.matchReasons?.map((reason) => <li key={reason}>{reason}</li>)}</ul></div>
          <p className="mt-7 text-sm leading-7 text-[hsl(var(--muted-foreground))]">{listing.description}</p>
          <a href={listing.url} target="_blank" rel="noreferrer" className="mt-6 inline-flex items-center gap-2 text-xs font-bold text-[hsl(var(--primary))]" data-testid={`link-employer-${listing.id}`}>{t('review.viewOriginalPosting')} <ExternalLink size={14} /></a>
        </article>
        <div className="grid gap-4">
          <section className="surface doc-panel"><div className="section-heading"><div><h3>{t('review.tailoredBullets')}</h3><p>{t('review.tailoredBulletsSubtitle')}</p></div><span className="badge badge-green">{t('review.ready')}</span></div><ul className="bullet-list">{listing.tailoredBullets?.map((bullet) => <li key={bullet}>{bullet}</li>)}</ul></section>
          <section className="surface doc-panel"><div className="section-heading"><div><h3>{t('review.coverLetter')}</h3><p>{t('review.coverLetterSubtitle')}</p></div><span className="font-mono-app text-[10px] text-[hsl(var(--muted-foreground))]">{t('common.charsCount', { count: letter.length })}</span></div><textarea className="textarea min-h-[220px] mt-2" value={letter} onChange={(event) => setLetter(event.target.value)} data-testid={`textarea-cover-letter-${listing.id}`} /><div className="flex justify-end mt-3"><button className="btn btn-ghost" onClick={() => setLetter(listing.coverLetter)} data-testid="button-reset-letter">{t('review.resetDraft')}</button></div></section>
          <section className="surface p-4"><div className="flex gap-2 mb-3"><a className="btn btn-ghost flex-1" href={getGetDocumentFileUrl('cv')} target="_blank" rel="noreferrer" data-testid="link-view-cv"><FileText size={14} /> {t('review.myResume')}</a><a className="btn btn-ghost flex-1" href={getGetJobCoverLetterPdfUrl(listing.id)} target="_blank" rel="noreferrer" data-testid="link-cover-letter-pdf"><FileDown size={14} /> {t('review.coverLetterPdf')}</a></div><div className="flex gap-2"><button className="btn btn-danger flex-1" onClick={handleSkip} disabled={skip.isPending || create.isPending} data-testid="button-skip-job"><SkipForward size={15} /> {t('review.skip')}</button><button className="btn btn-primary flex-[1.4]" onClick={handleApprove} disabled={skip.isPending || create.isPending} data-testid="button-approve-job"><Check size={15} /> {t('review.approveAndLog')}</button></div><div className="flex items-center justify-between mt-3"><button className="text-xs text-[hsl(var(--muted-foreground))] flex items-center gap-1 disabled:opacity-40" onClick={() => setIndex((value) => Math.max(0, value - 1))} disabled={index === 0} data-testid="button-previous-job"><ChevronLeft size={14} /> {t('review.previous')}</button><button className="text-xs text-[hsl(var(--muted-foreground))] flex items-center gap-1 disabled:opacity-40" onClick={() => setIndex((value) => Math.min(value + 1, jobs.data.length - 1))} disabled={index === jobs.data.length - 1} data-testid="button-next-job">{t('review.next')} <ChevronRight size={14} /></button></div></section>
        </div>
      </div>
    </div>
  );
}
