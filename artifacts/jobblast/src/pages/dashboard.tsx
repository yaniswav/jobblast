import { ArrowRight, Check, ChevronRight, Flame, Target, TrendingUp } from 'lucide-react';
import { Link } from 'wouter';
import { useGetDashboard } from '@workspace/api-client-react';
import { EmptyState, ErrorState, LoadingState } from '@/components/app-shell';

function formatDate(value: string) {
  return new Intl.DateTimeFormat('en', { month: 'short', day: 'numeric' }).format(new Date(value));
}

export default function Dashboard() {
  const dashboard = useGetDashboard();
  if (dashboard.isLoading) return <LoadingState />;
  if (dashboard.isError || !dashboard.data) return <div className="content-wrap"><ErrorState onRetry={() => dashboard.refetch()} /></div>;
  const data = dashboard.data;
  const goal = Math.min(100, data.dailyGoal ? (data.appliedToday / data.dailyGoal) * 100 : 0);
  return (
    <div className="content-wrap">
      <section className="mb-8">
        <div className="eyebrow">Today’s focus</div>
        <div className="mt-3 flex flex-wrap items-end justify-between gap-5">
          <div><h1 className="page-title">Make the next good move.</h1><p className="page-subtitle">Your queue is warm. There are a few strong signals worth your attention.</p></div>
          <Link href="/review" className="btn btn-primary" data-testid="link-start-review">Start reviewing <ArrowRight size={16} /></Link>
        </div>
      </section>
      <section className="stat-grid mb-7">
        <div className="surface stat-card list-enter"><div className="flex items-center justify-between"><span className="stat-label">Daily progress</span><Target size={17} className="text-[hsl(var(--primary))]" /></div><div className="stat-value">{data.appliedToday}<span className="text-lg text-[hsl(var(--muted-foreground))]"> / {data.dailyGoal}</span></div><div className="progress-track mt-4"><div className="progress-bar" style={{ width: `${goal}%` }} /></div></div>
        <div className="surface stat-card list-enter"><div className="flex items-center justify-between"><span className="stat-label">In review queue</span><BriefcaseIcon /></div><div className="stat-value">{data.queuedCount}</div><div className="text-xs text-[hsl(var(--primary))] mt-4 font-semibold">{data.strongMatchCount} strong matches</div></div>
        <div className="surface stat-card list-enter"><div className="flex items-center justify-between"><span className="stat-label">Response rate</span><TrendingUp size={17} className="text-[hsl(var(--accent))]" /></div><div className="stat-value">{data.responseRate}<span className="text-lg">%</span></div><div className="text-xs text-[hsl(var(--muted-foreground))] mt-4">Across active applications</div></div>
        <div className="surface stat-card list-enter"><div className="flex items-center justify-between"><span className="stat-label">Search streak</span><Flame size={17} className="text-[hsl(var(--accent))]" /></div><div className="stat-value">{data.streakDays}<span className="text-lg text-[hsl(var(--muted-foreground))]"> days</span></div><div className="text-xs text-[hsl(var(--muted-foreground))] mt-4">{data.needsFollowUp} follow-ups need a nudge</div></div>
      </section>
      <div className="grid gap-5 lg:grid-cols-[1.1fr_.9fr]">
        <section className="surface">
          <div className="p-5 pb-3 section-heading"><div><h2>Recent applications</h2><p>Keep your story moving forward.</p></div><Link href="/applications" className="text-xs font-bold text-[hsl(var(--primary))] flex items-center gap-1" data-testid="link-view-applications">View all <ChevronRight size={14} /></Link></div>
          {data.recentApplications?.length ? <div className="table-wrap"><table className="data-table"><thead><tr><th>Role</th><th>Status</th><th>Applied</th></tr></thead><tbody>{data.recentApplications.slice(0, 5).map((app) => <tr key={app.id} className="list-enter"><td><div className="flex items-center gap-3"><div className="avatar">{app.companyInitials}</div><div><div className="font-bold">{app.title}</div><div className="text-xs text-[hsl(var(--muted-foreground))]">{app.company} · {app.location}</div></div></div></td><td><StatusBadge status={app.status} /></td><td className="text-xs text-[hsl(var(--muted-foreground))]">{formatDate(app.appliedAt)}</td></tr>)}</tbody></table></div> : <EmptyState title="Your story starts here." body="Approve a strong match from the review queue and it will land here." action={<Link href="/review" className="btn btn-primary" data-testid="link-empty-review">Open review queue</Link>} />}
        </section>
        <section className="surface-dark p-6 relative overflow-hidden"><div className="absolute -right-12 -top-12 h-40 w-40 rounded-full border border-[hsl(var(--sidebar-primary)/.28)]" /><div className="absolute -right-5 -top-5 h-24 w-24 rounded-full border border-[hsl(var(--sidebar-primary)/.2)]" /><div className="eyebrow text-[hsl(var(--sidebar-primary))]">Funnel health</div><h2 className="text-2xl font-bold tracking-[-.05em] mt-3">Small moves, <span className="text-[hsl(var(--sidebar-primary))]">compounding.</span></h2><div className="grid grid-cols-3 gap-3 mt-8"><FunnelStat value={data.interviewCount} label="Interviews" /><FunnelStat value={data.offerCount} label="Offers" /><FunnelStat value={data.needsFollowUp} label="Follow-ups" /></div><div className="mt-8 pt-5 border-t border-[hsl(var(--sidebar-border))] flex items-center justify-between text-xs text-[hsl(var(--sidebar-foreground)/.65)]"><span>Queue health</span><span className="font-mono-app text-[hsl(var(--sidebar-primary))]">GOOD / {data.queuedCount} ready</span></div></section>
      </div>
    </div>
  );
}
function BriefcaseIcon() { return <span className="text-[hsl(var(--primary))] font-mono-app text-sm">Q</span>; }
function FunnelStat({ value, label }: { value: number; label: string }) { return <div><div className="text-3xl font-bold tracking-[-.06em]">{value}</div><div className="text-[10px] uppercase tracking-[.08em] text-[hsl(var(--sidebar-foreground)/.5)] mt-1">{label}</div></div>; }
function StatusBadge({ status }: { status: string }) { const tone = status === 'offer' || status === 'interview' ? 'badge-green' : status === 'rejected' ? 'badge-coral' : status === 'approved' ? 'badge-amber' : 'badge-muted'; const label = status === 'approved' ? 'à envoyer' : status; return <span className={`badge ${tone}`}>{label}</span>; }