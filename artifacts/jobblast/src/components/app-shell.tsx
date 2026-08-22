import { BarChart3, BriefcaseBusiness, CircleUserRound, LayoutDashboard, Menu, X } from 'lucide-react';
import { useState } from 'react';
import { Link, useLocation } from 'wouter';
import { useGetProfile, useHealthCheck } from '@workspace/api-client-react';

const navigation = [
  { href: '/', label: 'Overview', icon: LayoutDashboard },
  { href: '/review', label: 'Review queue', icon: BriefcaseBusiness },
  { href: '/applications', label: 'Applications', icon: BarChart3 },
  { href: '/profile', label: 'Your profile', icon: CircleUserRound },
];

function NavLinks({ onNavigate }: { onNavigate?: () => void }) {
  const [location] = useLocation();
  return (
    <>
      {navigation.map(({ href, label, icon: Icon }) => {
        const active = href === '/' ? location === '/' : location.startsWith(href);
        return (
          <Link key={href} href={href} className={`nav-item ${active ? 'active' : ''}`} onClick={onNavigate} data-testid={`link-${label.toLowerCase().replaceAll(' ', '-')}`}>
            <Icon size={17} strokeWidth={active ? 2.3 : 1.8} />
            <span>{label}</span>
          </Link>
        );
      })}
    </>
  );
}

export function AppShell({ children }: { children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  const { data: health } = useHealthCheck();
  const { data: profile } = useGetProfile();
  const [location] = useLocation();
  const current = navigation.find((item) => item.href === location || (item.href !== '/' && location.startsWith(item.href)));
  const initials = profile?.name
    ?.split(' ')
    .map((part) => part[0])
    .join('')
    .slice(0, 2)
    .toUpperCase() ?? 'JB';
  return (
    <div className="app-shell">
      <aside className="sidebar" aria-label="Main navigation">
        <Link href="/" className="flex items-center gap-3 px-2 mb-12" data-testid="link-brand">
          <span className="brand-mark">JB</span>
          <span className="font-mono-app text-[15px] font-bold tracking-[-.08em]">jobblast<span className="text-[hsl(var(--sidebar-primary))]">.</span></span>
        </Link>
        <div className="px-3 mb-3 eyebrow text-[hsl(var(--sidebar-primary))]">Workbench</div>
        <nav className="grid gap-1">
          <NavLinks />
        </nav>
        <div className="mt-auto">
          <div className="mx-2 mb-5 rounded-xl border border-[hsl(var(--sidebar-border))] bg-[hsl(var(--sidebar-accent))] p-3">
            <div className="flex items-center justify-between mb-2">
              <span className="text-[10px] font-mono-app uppercase tracking-[.1em] text-[hsl(var(--sidebar-foreground)/.55)]">System</span>
              <span className="h-2 w-2 rounded-full bg-[hsl(var(--sidebar-primary))]" data-testid="status-system" />
            </div>
            <p className="text-xs text-[hsl(var(--sidebar-foreground)/.8)]">{health?.status === 'ok' ? 'All systems ready' : 'Workspace connected'}</p>
          </div>
          <div className="px-3 text-[11px] text-[hsl(var(--sidebar-foreground)/.4)]">Built for the next good move.</div>
        </div>
      </aside>
      {open && (
        <div className="fixed inset-0 z-30 bg-[hsl(var(--foreground)/.34)]" onClick={() => setOpen(false)}>
          <aside className="sidebar !flex h-full" onClick={(event) => event.stopPropagation()}>
            <div className="flex items-center justify-between mb-10">
              <Link href="/" className="flex items-center gap-3" onClick={() => setOpen(false)} data-testid="link-mobile-brand">
                <span className="brand-mark">JB</span><span className="font-mono-app text-[15px] font-bold tracking-[-.08em]">jobblast<span className="text-[hsl(var(--sidebar-primary))]">.</span></span>
              </Link>
              <button className="btn icon-btn text-[hsl(var(--sidebar-foreground))]" onClick={() => setOpen(false)} aria-label="Close menu" data-testid="button-close-menu"><X size={18} /></button>
            </div>
            <NavLinks onNavigate={() => setOpen(false)} />
          </aside>
        </div>
      )}
      <div className="main-area">
        <header className="topbar">
          <div className="flex items-center gap-3">
            <button className="btn btn-ghost icon-btn mobile-menu" onClick={() => setOpen(true)} aria-label="Open menu" data-testid="button-open-menu"><Menu size={18} /></button>
            <div>
              <div className="eyebrow">{current?.label ?? 'Workspace'}</div>
              <div className="text-xs text-[hsl(var(--muted-foreground))] mt-1">
                {new Intl.DateTimeFormat('en', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' }).format(new Date())}
              </div>
            </div>
          </div>
          <Link href="/profile" className="flex items-center gap-3 group" data-testid="link-top-profile">
            <div className="text-right hide-mobile">
              <div className="text-xs font-bold">{profile?.name ?? 'Your profile'}</div>
              <div className="text-[10px] text-[hsl(var(--muted-foreground))]">{profile?.headline ?? 'Profile loading'}</div>
            </div>
            <div className="avatar group-hover:bg-[hsl(var(--primary)/.2)] transition-colors">{initials}</div>
          </Link>
        </header>
        <main>{children}</main>
        <nav className="mobile-nav"><NavLinks /></nav>
      </div>
    </div>
  );
}

export function LoadingState({ label = 'Loading workspace' }: { label?: string }) {
  return <div className="content-wrap"><div className="surface p-6" data-testid="status-loading"><div className="skeleton h-3 w-28 mb-5" /><div className="skeleton h-10 w-64 mb-3" /><div className="skeleton h-4 w-96 max-w-full mb-8" /><div className="grid gap-3 md:grid-cols-4"><div className="skeleton h-28" /><div className="skeleton h-28" /><div className="skeleton h-28" /><div className="skeleton h-28" /></div><span className="sr-only">{label}</span></div></div>;
}

export function ErrorState({ onRetry }: { onRetry?: () => void }) {
  return <div className="surface empty-state" data-testid="status-error"><div><div className="empty-orbit"><X size={18} /></div><h2 className="font-bold text-lg">The workspace hit a snag.</h2><p className="text-sm text-[hsl(var(--muted-foreground))] mt-2 mb-5">Your data could not be loaded. Try that again.</p>{onRetry && <button className="btn btn-primary" onClick={onRetry} data-testid="button-retry">Retry</button>}</div></div>;
}

export function EmptyState({ title, body, action }: { title: string; body: string; action?: React.ReactNode }) {
  return <div className="empty-state"><div><div className="empty-orbit"><BriefcaseBusiness size={19} /></div><h2 className="font-bold text-lg">{title}</h2><p className="text-sm text-[hsl(var(--muted-foreground))] mt-2 max-w-xs mx-auto">{body}</p>{action && <div className="mt-5">{action}</div>}</div></div>;
}