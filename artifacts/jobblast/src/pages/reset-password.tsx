import { useState, type FormEvent } from 'react';
import { useResetPassword } from '@workspace/api-client-react';
import { useT } from '@/i18n';

const basePath = () => import.meta.env.BASE_URL.replace(/\/$/, '');

function tokenFromUrl(): string {
  return new URLSearchParams(window.location.search).get('token') ?? '';
}

/**
 * Only ever rendered in SaaS mode, only while nobody is signed in - reached
 * from the link in the reset email (`APP_ORIGIN/reset?token=...`). Every
 * session on the account is invalidated server-side the moment this
 * succeeds (lib/auth/store.ts's resetPassword()), so there is nothing to
 * sign the caller out of here; a plain link back to the sign-in screen is
 * enough.
 */
export default function ResetPassword({ emailEnabled }: { emailEnabled: boolean }) {
  const t = useT();
  const [token] = useState(tokenFromUrl);
  const [newPassword, setNewPassword] = useState('');
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const reset = useResetPassword();

  const submit = (event: FormEvent) => {
    event.preventDefault();
    setError(null);
    reset.mutate(
      { data: { token, newPassword } },
      {
        onSuccess: () => setDone(true),
        onError: (err) => setError(err instanceof Error && err.message ? err.message : t('auth.resetFailed')),
      },
    );
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
        <h1 className="text-2xl font-bold tracking-[-.04em]">{t('auth.resetTitle')}</h1>
        <p className="page-subtitle mt-1 mb-6">{t('auth.resetSubtitle')}</p>
        {!emailEnabled ? (
          <div className="flex flex-col gap-4">
            <p className="text-sm text-[hsl(var(--muted-foreground))]">{t('auth.forgotUnavailable')}</p>
            <a href={`${basePath()}/`} className="text-sm text-[hsl(var(--muted-foreground))] underline underline-offset-4">
              {t('auth.backToSignIn')}
            </a>
          </div>
        ) : !token ? (
          <div className="flex flex-col gap-4">
            <p className="text-sm text-[hsl(var(--muted-foreground))]">{t('auth.resetMissingToken')}</p>
            <a href={`${basePath()}/forgot`} className="text-sm text-[hsl(var(--muted-foreground))] underline underline-offset-4">
              {t('auth.forgotTitle')}
            </a>
          </div>
        ) : done ? (
          <div className="flex flex-col gap-4">
            <p className="text-sm text-[hsl(var(--muted-foreground))]" role="status">
              {t('auth.resetSuccessNotice')}
            </p>
            <a href={`${basePath()}/`} className="text-sm text-[hsl(var(--muted-foreground))] underline underline-offset-4">
              {t('auth.backToSignIn')}
            </a>
          </div>
        ) : (
          <form className="flex flex-col gap-4" onSubmit={submit}>
            <div>
              <label className="label" htmlFor="reset-new-password">{t('auth.resetNewPasswordLabel')}</label>
              <input
                id="reset-new-password"
                name="newPassword"
                type="password"
                autoComplete="new-password"
                required
                className="input"
                value={newPassword}
                onChange={(event) => setNewPassword(event.target.value)}
              />
              <p className="text-xs text-[hsl(var(--muted-foreground))] mt-2">{t('auth.passwordHint')}</p>
            </div>

            {error && (
              <p role="alert" className="text-sm text-[hsl(var(--destructive))]">
                {error}
              </p>
            )}

            <button type="submit" className="btn btn-primary w-full" disabled={reset.isPending}>
              {reset.isPending ? t('auth.working') : t('auth.resetSubmitButton')}
            </button>
          </form>
        )}
      </section>
    </div>
  );
}
