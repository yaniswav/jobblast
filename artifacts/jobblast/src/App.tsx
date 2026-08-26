import { type ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { getGetOnboardingStatusQueryKey, useGetAuthSession, useGetOnboardingStatus } from '@workspace/api-client-react';
import { ErrorBoundary } from '@/components/error-boundary';
import { Toaster } from '@/components/ui/toaster';
import { Toaster as SonnerToaster } from '@/components/ui/sonner';
import { TooltipProvider } from '@/components/ui/tooltip';
import NotFound from '@/pages/not-found';
import Dashboard from '@/pages/dashboard';
import Login from '@/pages/login';
import ForgotPassword from '@/pages/forgot-password';
import ResetPassword from '@/pages/reset-password';
import Try from '@/pages/try';
import Onboarding from '@/pages/onboarding';
import Review from '@/pages/review';
import Applications from '@/pages/applications';
import Profile from '@/pages/profile';
import Settings from '@/pages/settings';
import Privacy from '@/pages/privacy';
import { Route, Switch, useLocation, Router as WouterRouter } from 'wouter';
import { AppShell } from '@/components/app-shell';
import { I18nProvider, useT } from '@/i18n';

const queryClient = new QueryClient();

function Router() {
  return <RoutedErrorBoundary><AppShell><Switch><Route path="/" component={Dashboard} /><Route path="/review" component={Review} /><Route path="/applications" component={Applications} /><Route path="/profile" component={Profile} /><Route path="/settings" component={Settings} /><Route path="/privacy" component={Privacy} /><Route component={NotFound} /></Switch></AppShell></RoutedErrorBoundary>;
}

function RoutedErrorBoundary({ children }: { children: ReactNode }) {
  const [location] = useLocation();
  return <ErrorBoundary resetKey={location}>{children}</ErrorBoundary>;
}

/**
 * Decides whether the app or the sign-in screen renders.
 *
 * The server reports its own mode: a self-hosted install always answers with
 * its implicit local user, so `user` is never null there and the sign-in
 * screen is unreachable. Only a `saas` server can answer with no user.
 */
function AuthGate({ children }: { children: ReactNode }) {
  const t = useT();
  const session = useGetAuthSession();

  if (session.isPending) {
    return (
      <div className="min-h-screen w-full flex items-center justify-center bg-gray-50">
        <p className="text-sm text-gray-500">{t('loading.workspace')}</p>
      </div>
    );
  }

  // A failed probe must not lock a self-hosted owner out of their own
  // install: fall through to the app, which surfaces the real error.
  if (session.data && session.data.user === null) {
    // No wouter router is mounted yet at this point (it wraps AuthGate's
    // children, further down) - a plain path check against the real browser
    // location, same as the plain <a> links these three screens use to
    // navigate between each other (see pages/login.tsx's privacy link).
    const path = window.location.pathname.replace(import.meta.env.BASE_URL.replace(/\/$/, ''), '') || '/';
    if (path === '/forgot') return <ForgotPassword emailEnabled={session.data.emailEnabled} />;
    if (path === '/reset') return <ResetPassword emailEnabled={session.data.emailEnabled} />;
    // The anonymous trial (lot H1, pages/try.tsx): reachable from the login
    // screen's "try it with your CV" link without ever needing a session -
    // GET /auth/session still reports mode: 'saas' with no user, exactly
    // like every other screen in this branch.
    if (path === '/try') return <Try />;
    return <Login emailEnabled={session.data.emailEnabled} />;
  }

  return <>{children}</>;
}

/**
 * Decides whether the guided setup wizard or the real app renders, for a
 * signed-in saas account.
 *
 * `GET /onboarding/status` 404s in selfhosted (never enabled there), so the
 * query only runs once we know the mode - a self-hosted install never even
 * makes this request, let alone shows the wizard. A saas account that has
 * already finished onboarding gets the same treatment: `completed` stays
 * true forever after the Finish step, so this component is a no-op for it on
 * every later visit.
 */
function OnboardingGate({ children }: { children: ReactNode }) {
  const t = useT();
  const session = useGetAuthSession();
  const isSaas = session.data?.mode === 'saas';
  const status = useGetOnboardingStatus({ query: { queryKey: getGetOnboardingStatusQueryKey(), enabled: isSaas } });

  if (!isSaas) return <>{children}</>;

  if (status.isPending) {
    return (
      <div className="min-h-screen w-full flex items-center justify-center bg-gray-50">
        <p className="text-sm text-gray-500">{t('loading.workspace')}</p>
      </div>
    );
  }

  // A failed probe falls through to the real app rather than trapping the
  // account on a wizard that cannot load - the same fail-open choice AuthGate
  // makes above.
  if (status.data && !status.data.completed) {
    return <Onboarding nextStep={status.data.nextStep ?? 'profile'} />;
  }

  return <>{children}</>;
}

function App() {
  return <I18nProvider><QueryClientProvider client={queryClient}><TooltipProvider><AuthGate><OnboardingGate><WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, '')}><Router /></WouterRouter></OnboardingGate></AuthGate><Toaster /><SonnerToaster /></TooltipProvider></QueryClientProvider></I18nProvider>;
}

export default App;
