import { useState, type FormEvent } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { getGetAuthSessionQueryKey, useLogin, useRegister } from '@workspace/api-client-react';
import { useT } from '@/i18n';

type Mode = 'signIn' | 'register';

/**
 * Only ever rendered in SaaS mode, and only while nobody is signed in. A
 * self-hosted install reports its implicit local user from
 * GET /auth/session, so this screen never mounts there.
 */
export default function Login({ emailEnabled }: { emailEnabled: boolean }) {
  const t = useT();
  const queryClient = useQueryClient();
  const [mode, setMode] = useState<Mode>('signIn');
  const [inviteCode, setInviteCode] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);

  const onSettled = () => {
    void queryClient.invalidateQueries({ queryKey: getGetAuthSessionQueryKey() });
  };

  const login = useLogin({ mutation: { onSuccess: onSettled } });
  const register = useRegister({ mutation: { onSuccess: onSettled } });
  const pending = login.isPending || register.isPending;

  const submit = (event: FormEvent) => {
    event.preventDefault();
    setError(null);
    const fail = () => {
      setError(mode === 'signIn' ? t('auth.signInFailed') : t('auth.registerFailed'));
    };
    if (mode === 'signIn') {
      login.mutate({ data: { email, password } }, { onError: fail });
    } else {
      register.mutate({ data: { inviteCode, email, password } }, { onError: fail });
    }
  };

  return (
    <div className="min-h-screen w-full bg-background flex flex-col items-center justify-center px-4 py-10">
      <div className="flex items-center gap-3 mb-8">
        <span className="brand-mark">JB</span>
        <span className="font-mono-app text-[15px] font-bold tracking-[-.08em]">
          jobblast<span className="text-[hsl(var(--primary))]">.</span>
        </span>
      </div>
      <section className="surface w-full max-w-md p-6">
        <div className="eyebrow">{t('auth.eyebrow')}</div>
        <h1 className="text-2xl font-bold tracking-[-.04em] mt-3">
          {mode === 'signIn' ? t('auth.signInTitle') : t('auth.registerTitle')}
        </h1>
        <p className="page-subtitle mt-1 mb-6">
          {mode === 'signIn' ? t('auth.signInSubtitle') : t('auth.registerSubtitle')}
        </p>
        <form className="flex flex-col gap-4" onSubmit={submit}>
          {mode === 'register' && (
            <div>
              <label className="label" htmlFor="inviteCode">{t('auth.inviteCodeLabel')}</label>
              <input
                id="inviteCode"
                name="inviteCode"
                autoComplete="off"
                required
                className="input"
                value={inviteCode}
                onChange={(event) => setInviteCode(event.target.value)}
              />
            </div>
          )}

          <div>
            <label className="label" htmlFor="email">{t('auth.emailLabel')}</label>
            <input
              id="email"
              name="email"
              type="email"
              autoComplete="email"
              required
              className="input"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
            />
          </div>

          <div>
            <label className="label" htmlFor="password">{t('auth.passwordLabel')}</label>
            <input
              id="password"
              name="password"
              type="password"
              autoComplete={mode === 'signIn' ? 'current-password' : 'new-password'}
              required
              className="input"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
            />
            {mode === 'register' && (
              <p className="text-xs text-[hsl(var(--muted-foreground))] mt-2">{t('auth.passwordHint')}</p>
            )}
            {mode === 'signIn' && emailEnabled && (
              <a
                href={`${import.meta.env.BASE_URL.replace(/\/$/, '')}/forgot`}
                className="text-xs text-[hsl(var(--muted-foreground))] underline underline-offset-4 mt-2 inline-block"
                data-testid="link-forgot-password"
              >
                {t('auth.forgotPasswordLink')}
              </a>
            )}
          </div>

          {error && (
            <p role="alert" className="text-sm text-[hsl(var(--destructive))]">
              {error}
            </p>
          )}

          <button type="submit" className="btn btn-primary w-full" disabled={pending}>
            {pending
              ? t('auth.working')
              : mode === 'signIn'
                ? t('auth.signInAction')
                : t('auth.registerAction')}
          </button>

          <button
            type="button"
            className="text-sm text-[hsl(var(--muted-foreground))] underline underline-offset-4"
            onClick={() => {
              setMode(mode === 'signIn' ? 'register' : 'signIn');
              setError(null);
            }}
          >
            {mode === 'signIn' ? t('auth.switchToRegister') : t('auth.switchToSignIn')}
          </button>

          {/* Plain anchors, not wouter <Link>s: this screen renders outside
              the router (see App.tsx's AuthGate), since nobody is signed in
              yet. The trial link (lot H1) leads to pages/try.tsx, which
              AuthGate special-cases the same way it does /forgot and
              /reset. */}
          <a
            href={`${import.meta.env.BASE_URL.replace(/\/$/, '')}/try`}
            className="text-center text-sm text-[hsl(var(--muted-foreground))] underline underline-offset-4"
            data-testid="link-try-anonymous"
          >
            {t('auth.tryLinkLabel')}
          </a>

          <a
            href={`${import.meta.env.BASE_URL.replace(/\/$/, '')}/privacy`}
            className="text-center text-xs text-[hsl(var(--muted-foreground))] underline underline-offset-4"
          >
            {t('privacy.linkLabel')}
          </a>
        </form>
      </section>
    </div>
  );
}
