import { CalendarClock, Check, ChevronDown, CircleAlert, Edit3, ExternalLink, Filter, MessageSquareText, Search, X } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { ApplicationStatus, getGetDashboardQueryKey, getGetJobQueryKey, getListApplicationsQueryKey, useGetJob, useListApplications, useUpdateApplication } from '@workspace/api-client-react';
import type { Application, ApplicationStatus as ApplicationStatusType } from '@workspace/api-client-react';
import { EmptyState, ErrorState, LoadingState } from '@/components/app-shell';

const statuses = Object.values(ApplicationStatus);
const statusLabel: Record<string, string> = { queued: 'Queued', approved: 'À ENVOYER', applied: 'Applied', responded: 'Responded', interview: 'Interview', rejected: 'Rejected', offer: 'Offer' };

export default function Applications() {
  const [filter, setFilter] = useState<'all' | ApplicationStatusType>('all');
  const [search, setSearch] = useState('');
  const [editing, setEditing] = useState<Application | null>(null);
  const applications = useListApplications(filter === 'all' ? undefined : { status: filter });
  const visible = useMemo(() => (applications.data ?? []).filter((app) => `${app.title} ${app.company} ${app.location}`.toLowerCase().includes(search.toLowerCase())), [applications.data, search]);
  if (applications.isLoading) return <LoadingState label="Loading applications" />;
  if (applications.isError) return <div className="content-wrap"><ErrorState onRetry={() => applications.refetch()} /></div>;
  return (
    <div className="content-wrap">
      <section className="mb-7"><div className="eyebrow">Application tracker</div><h1 className="page-title mt-3">Keep every thread warm.</h1><p className="page-subtitle">A clear view from first signal to offer.</p></section>
      <div className="surface p-3 mb-4 flex flex-wrap items-center gap-2">
        <div className="relative flex-1 min-w-[200px]"><Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-[hsl(var(--muted-foreground))]" /><input className="input pl-9" type="search" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search roles, companies, locations" data-testid="input-search-applications" /></div>
        <div className="flex items-center gap-2 text-xs font-bold text-[hsl(var(--muted-foreground))]"><Filter size={14} /> Filter</div>
        <select className="select w-auto min-w-[130px]" value={filter} onChange={(event) => setFilter(event.target.value as typeof filter)} data-testid="select-application-status"><option value="all">All statuses</option>{statuses.map((status) => <option value={status} key={status}>{statusLabel[status]}</option>)}</select>
      </div>
      <section className="surface">
        {visible.length ? <div className="table-wrap"><table className="data-table"><thead><tr><th>Role</th><th>Status</th><th>Follow-up</th><th>Notes</th><th><span className="sr-only">Actions</span></th></tr></thead><tbody>{visible.map((application) => <ApplicationRow key={application.id} application={application} onEdit={() => setEditing(application)} />)}</tbody></table></div> : <EmptyState title={search ? 'No applications match.' : 'Nothing tracked yet.'} body={search ? 'Try a different role, company, or location.' : 'Approve a role in review and it will appear in your tracker.'} /> }
      </section>
      {editing && <EditApplication application={editing} onClose={() => setEditing(null)} />}
    </div>
  );
}

function ApplicationRow({ application, onEdit }: { application: Application; onEdit: () => void }) {
  const isApproved = application.status === 'approved';
  const tone = application.status === 'offer' || application.status === 'interview' ? 'badge-green' : application.status === 'rejected' ? 'badge-coral' : isApproved ? 'badge-amber' : application.status === 'applied' ? 'badge-dark' : 'badge-muted';
  const due = application.followUpDate && new Date(application.followUpDate) <= new Date();
  const queryClient = useQueryClient();
  // Only fetch the job (for its posting URL) when the row actually needs the
  // "Ouvrir l'offre" action — the application record itself doesn't carry a url.
  const job = useGetJob(application.jobId, { query: { enabled: isApproved, queryKey: getGetJobQueryKey(application.jobId) } });
  const markApplied = useUpdateApplication();
  const handleMarkApplied = () => markApplied.mutate({ id: application.id, data: { status: ApplicationStatus.applied } }, {
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: getListApplicationsQueryKey() });
      queryClient.invalidateQueries({ queryKey: getGetDashboardQueryKey() });
      toast('Marquée comme envoyée — bonne chance !');
    },
    onError: () => toast('Échec de la mise à jour du statut.'),
  });
  return <tr className="list-enter" data-testid={`row-application-${application.id}`}><td><div className="flex items-center gap-3"><div className="avatar">{application.companyInitials}</div><div><div className="font-bold">{application.title}</div><div className="text-xs text-[hsl(var(--muted-foreground))] mt-1">{application.company} · {application.location}</div></div></div></td><td><span className={`badge ${tone}`}>{statusLabel[application.status]}</span></td><td>{application.followUpDate ? <div className={`flex items-center gap-1.5 text-xs ${due ? 'text-[hsl(var(--accent))] font-bold' : 'text-[hsl(var(--muted-foreground))]'}`}><CalendarClock size={14} />{due ? 'Due now' : new Date(application.followUpDate).toLocaleDateString('en', { month: 'short', day: 'numeric' })}</div> : <span className="text-xs text-[hsl(var(--muted-foreground))]">—</span>}</td><td><div className="max-w-[210px] truncate text-xs text-[hsl(var(--muted-foreground))]" title={application.notes}>{application.notes || 'No note yet'}</div></td><td><div className="flex items-center justify-end gap-2">{isApproved && <a className="btn btn-ghost" href={job.data?.url} target="_blank" rel="noreferrer" aria-disabled={!job.data?.url} onClick={(event) => { if (!job.data?.url) event.preventDefault(); }} data-testid={`link-open-job-${application.id}`}><ExternalLink size={14} /> Ouvrir l'offre</a>}{isApproved && <button className="btn btn-primary" onClick={handleMarkApplied} disabled={markApplied.isPending} data-testid={`button-mark-applied-${application.id}`}><Check size={14} /> {markApplied.isPending ? 'Envoi…' : "J'ai postulé"}</button>}<button className="btn btn-ghost icon-btn" onClick={onEdit} aria-label={`Edit ${application.title}`} data-testid={`button-edit-application-${application.id}`}><Edit3 size={15} /></button></div></td></tr>;
}

function EditApplication({ application, onClose }: { application: Application; onClose: () => void }) {
  const update = useUpdateApplication();
  const queryClient = useQueryClient();
  const [status, setStatus] = useState<ApplicationStatusType>(application.status);
  const [notes, setNotes] = useState(application.notes);
  const [followUpDate, setFollowUpDate] = useState(application.followUpDate ?? '');
  const save = () => update.mutate({ id: application.id, data: { status, notes, followUpDate: followUpDate || null } }, { onSuccess: () => { queryClient.invalidateQueries({ queryKey: getListApplicationsQueryKey() }); queryClient.invalidateQueries({ queryKey: getGetDashboardQueryKey() }); onClose(); } });
  return <div className="fixed inset-0 z-40 grid place-items-center bg-[hsl(var(--foreground)/.38)] p-4" onClick={onClose}><div className="surface w-full max-w-lg p-6 shadow-2xl" onClick={(event) => event.stopPropagation()}><div className="flex items-start justify-between gap-4 mb-6"><div><div className="eyebrow">Update thread</div><h2 className="text-xl font-bold tracking-[-.04em] mt-2">{application.title}</h2><p className="text-xs text-[hsl(var(--muted-foreground))] mt-1">{application.company}</p></div><button className="btn btn-ghost icon-btn" onClick={onClose} aria-label="Close editor" data-testid="button-close-application-editor"><X size={17} /></button></div><div className="grid gap-4"><div><label className="label" htmlFor="application-status">Status</label><select id="application-status" className="select" value={status} onChange={(event) => setStatus(event.target.value as ApplicationStatusType)} data-testid="select-edit-application-status">{statuses.map((value) => <option value={value} key={value}>{statusLabel[value]}</option>)}</select></div><div><label className="label" htmlFor="follow-up-date">Follow-up date</label><input id="follow-up-date" className="input" type="date" value={followUpDate} onChange={(event) => setFollowUpDate(event.target.value)} data-testid="input-follow-up-date" /></div><div><label className="label" htmlFor="application-notes">Notes</label><textarea id="application-notes" className="textarea min-h-[120px]" value={notes} onChange={(event) => setNotes(event.target.value)} placeholder="What did you learn? What is the next move?" data-testid="textarea-application-notes" /></div></div><div className="flex justify-end gap-2 mt-6"><button className="btn btn-ghost" onClick={onClose} data-testid="button-cancel-application-edit">Cancel</button><button className="btn btn-primary" onClick={save} disabled={update.isPending} data-testid="button-save-application"><Check size={15} /> {update.isPending ? 'Saving' : 'Save changes'}</button></div></div></div>;
}