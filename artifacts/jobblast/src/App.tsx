import { type ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useGetAuthSession } from '@workspace/api-client-react';
import { ErrorBoundary } from '@/components/error-boundary';
import { Toaster } from '@/components/ui/toaster';
import { Toaster as SonnerToaster } from '@/components/ui/sonner';
import { TooltipProvider } from '@/components/ui/tooltip';
import NotFound from '@/pages/not-found';
import Dashboard from '@/pages/dashboard';
import Login from '@/pages/login';
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
  if (session.data && session.data.user === null) return <Login />;

  return <>{children}</>;
}

function App() {
  return <I18nProvider><QueryClientProvider client={queryClient}><TooltipProvider><AuthGate><WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, '')}><Router /></WouterRouter></AuthGate><Toaster /><SonnerToaster /></TooltipProvider></QueryClientProvider></I18nProvider>;
}

export default App;
