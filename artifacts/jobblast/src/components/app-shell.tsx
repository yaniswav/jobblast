import { BarChart3, BriefcaseBusiness, CircleUserRound, LayoutDashboard, Menu, X } from 'lucide-react';
import { useState } from 'react';
import { Link, useLocation } from 'wouter';
import { useGetProfile, useHealthCheck } from '@workspace/api-client-react';
import { useLocale, useT, type TranslationKey } from '@/i18n';

const navigation: { href: string; labelKey: TranslationKey; icon: typeof LayoutDashboard; testId: string }[] = [
  { href: '/', labelKey: 'nav.overview', icon: LayoutDashboard, testId: 'link-overview' },
  { href: '/review', labelKey: 'nav.reviewQueue', icon: BriefcaseBusiness, testId: 'link-review-queue' },
  { href: '/applications', labelKey: 'nav.applications', icon: BarChart3, testId: 'link-applications' },
  { href: '/profile', labelKey: 'nav.profile', icon: CircleUserRound, testId: 'link-your-profile' },
];

function NavLinks({ onNavigate }: { onNavigate?: () => void }) {
  const [location] = useLocation();
  const t = useT();
  return (
    <>
      {navigation.map(({ href, labelKey, icon: Icon, testId }) => {
        const active = href === '/' ? location === '/' : location.startsWith(href);
        return (
          <Link key={href} href={href} className={`nav-item ${active ? 'active' : ''}`} onClick={onNavigate} data-testid={testId}>
            <Icon size={17} strokeWidth={active ? 2.3 : 1.8} />
            <span>{t(labelKey)}</span>
          </Link>
        );
      })}
    </>
  );
}

function LanguageToggle() {
  const [locale, setLocale] = useLocale();
  const t = useT();
  return (
    <div className="flex items-center gap-1 rounded-full border border-[hsl(var(--border))] p-0.5 font-mono-app text-[10px] font-bold" role="group" aria-label={t('shell.languageToggle')}>
      <button
        type="button"
        className={`rounded-full px-2 py-1 transition-colors ${locale === 'en' ? 'bg-[hsl(var(--primary))] text-[hsl(var(--primary-foreground))]' : 'text-[hsl(var(--muted-foreground))]'}`}
        onClick={() => setLocale('en')}
        aria-pressed={locale === 'en'}
        data-testid="button-locale-en"
      >
        EN
      </button>
      <button
        type="button"
        className={`rounded-full px-2 py-1 transition-colors ${locale === 'fr' ? 'bg-[hsl(var(--primary))] text-[hsl(var(--primary-foreground))]' : 'text-[hsl(var(--muted-foreground))]'}`}
        onClick={() => setLocale('fr')}
        aria-pressed={locale === 'fr'}
        data-testid="button-locale-fr"
      >
        FR
      </button>
    </div>
  );
}

export function AppShell({ children }: { children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  const { data: health } = useHealthCheck();
  const { data: profile } = useGetProfile();
  const [location] = useLocation();
  const [locale] = useLocale();
  const t = useT();
  const current = navigation.find((item) => item.href === location || (item.href !== '/' && location.startsWith(item.href)));
  const initials = profile?.name
    ?.split(' ')
    .map((part) => part[0])
    .join('')
    .slice(0, 2)
    .toUpperCase() ?? 'JB';
  return (
    <div className="app-shell">
      <aside className="sidebar" aria-label={t('shell.mainNavigation')}>
        <Link href="/" className="flex items-center gap-3 px-2 mb-12" data-testid="link-brand">
          <span className="brand-mark">JB</span>
          <span className="font-mono-app text-[15px] font-bold tracking-[-.08em]">jobblast<span className="text-[hsl(var(--sidebar-primary))]">.</span></span>
        </Link>
        <div className="px-3 mb-3 eyebrow text-[hsl(var(--sidebar-primary))]">{t('shell.workbench')}</div>
        <nav className="grid gap-1">
          <NavLinks />
        </nav>
        <div className="mt-auto">
          <div className="mx-2 mb-5 rounded-xl border border-[hsl(var(--sidebar-border))] bg-[hsl(var(--sidebar-accent))] p-3">
            <div className="flex items-center justify-between mb-2">
              <span className="text-[10px] font-mono-app uppercase tracking-[.1em] text-[hsl(var(--sidebar-foreground)/.55)]">{t('shell.system')}</span>
              <span className="h-2 w-2 rounded-full bg-[hsl(var(--sidebar-primary))]" data-testid="status-system" />
            </div>
            <p className="text-xs text-[hsl(var(--sidebar-foreground)/.8)]">{health?.status === 'ok' ? t('shell.systemsReady') : t('shell.workspaceConnected')}</p>
          </div>
          <div className="px-3 text-[11px] text-[hsl(var(--sidebar-foreground)/.4)]">{t('shell.builtForNextMove')}</div>
        </div>
      </aside>
      {open && (
        <div className="fixed inset-0 z-30 bg-[hsl(var(--foreground)/.34)]" onClick={() => setOpen(false)}>
          <aside className="sidebar !flex h-full" onClick={(event) => event.stopPropagation()}>
            <div className="flex items-center justify-between mb-10">
              <Link href="/" className="flex items-center gap-3" onClick={() => setOpen(false)} data-testid="link-mobile-brand">
                <span className="brand-mark">JB</span><span className="font-mono-app text-[15px] font-bold tracking-[-.08em]">jobblast<span className="text-[hsl(var(--sidebar-primary))]">.</span></span>
              </Link>
              <button className="btn icon-btn text-[hsl(var(--sidebar-foreground))]" onClick={() => setOpen(false)} aria-label={t('shell.closeMenu')} data-testid="button-close-menu"><X size={18} /></button>
            </div>
            <NavLinks onNavigate={() => setOpen(false)} />
          </aside>
        </div>
      )}
      <div className="main-area">
        <header className="topbar">
          <div className="flex items-center gap-3">
            <button className="btn btn-ghost icon-btn mobile-menu" onClick={() => setOpen(true)} aria-label={t('shell.openMenu')} data-testid="button-open-menu"><Menu size={18} /></button>
            <div>
              <div className="eyebrow">{current ? t(current.labelKey) : t('nav.workspace')}</div>
              <div className="text-xs text-[hsl(var(--muted-foreground))] mt-1">
                {new Intl.DateTimeFormat(locale, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' }).format(new Date())}
              </div>
            </div>
          </div>
          <div className="flex items-center gap-4">
            <LanguageToggle />
            <Link href="/profile" className="flex items-center gap-3 group" data-testid="link-top-profile">
              <div className="text-right hide-mobile">
                <div className="text-xs font-bold">{profile?.name ?? t('shell.yourProfile')}</div>
                <div className="text-[10px] text-[hsl(var(--muted-foreground))]">{profile?.headline ?? t('shell.profileLoading')}</div>
              </div>
              <div className="avatar group-hover:bg-[hsl(var(--primary)/.2)] transition-colors">{initials}</div>
            </Link>
          </div>
        </header>
        <main>{children}</main>
        <nav className="mobile-nav"><NavLinks /></nav>
      </div>
    </div>
  );
}

export function LoadingState({ label }: { label?: string }) {
  const t = useT();
  return <div className="content-wrap"><div className="surface p-6" data-testid="status-loading"><div className="skeleton h-3 w-28 mb-5" /><div className="skeleton h-10 w-64 mb-3" /><div className="skeleton h-4 w-96 max-w-full mb-8" /><div className="grid gap-3 md:grid-cols-4"><div className="skeleton h-28" /><div className="skeleton h-28" /><div className="skeleton h-28" /><div className="skeleton h-28" /></div><span className="sr-only">{label ?? t('loading.workspace')}</span></div></div>;
}

export function ErrorState({ onRetry }: { onRetry?: () => void }) {
  const t = useT();
  return <div className="surface empty-state" data-testid="status-error"><div><div className="empty-orbit"><X size={18} /></div><h2 className="font-bold text-lg">{t('error.title')}</h2><p className="text-sm text-[hsl(var(--muted-foreground))] mt-2 mb-5">{t('error.body')}</p>{onRetry && <button className="btn btn-primary" onClick={onRetry} data-testid="button-retry">{t('error.retry')}</button>}</div></div>;
}

export function EmptyState({ title, body, action }: { title: string; body: string; action?: React.ReactNode }) {
  return <div className="empty-state"><div><div className="empty-orbit"><BriefcaseBusiness size={19} /></div><h2 className="font-bold text-lg">{title}</h2><p className="text-sm text-[hsl(var(--muted-foreground))] mt-2 max-w-xs mx-auto">{body}</p>{action && <div className="mt-5">{action}</div>}</div></div>;
}
