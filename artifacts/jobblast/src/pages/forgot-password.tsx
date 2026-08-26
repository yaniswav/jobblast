import { useState, type FormEvent } from 'react';
import { useForgotPassword } from '@workspace/api-client-react';
import { useT } from '@/i18n';

const basePath = () => import.meta.env.BASE_URL.replace(/\/$/, '');

/**
 * Only ever rendered in SaaS mode, only while nobody is signed in, and only
 * when the server announced `emailEnabled` (App.tsx's AuthGate checks the
 * path before this mounts). Reached from the "forgot password" link on the
 * login screen, which itself only renders under that same condition - see
 * pages/login.tsx.
 */
export default function ForgotPassword({ emailEnabled }: { emailEnabled: boolean }) {
  const t = useT();
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState(false);
  const forgot = useForgotPassword();

  const submit = (event: FormEvent) => {
    event.preventDefault();
    // Always ends at the same "sent" screen, whatever the server actually
    // did (docs/SAAS-ARCHITECTURE.md section 2: the endpoint never confirms
    // which addresses are registered, and neither does this screen).
    forgot.mutate({ data: { email } }, { onSettled: () => setSent(true) });
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
        <h1 className="text-2xl font-bold tracking-[-.04em]">{t('auth.forgotTitle')}</h1>
        <p className="page-subtitle mt-1 mb-6">{t('auth.forgotSubtitle')}</p>
        {!emailEnabled ? (
          <div className="flex flex-col gap-4">
            <p className="text-sm text-[hsl(var(--muted-foreground))]">{t('auth.forgotUnavailable')}</p>
            <a href={`${basePath()}/`} className="text-sm text-[hsl(var(--muted-foreground))] underline underline-offset-4">
              {t('auth.backToSignIn')}
            </a>
          </div>
        ) : sent ? (
          <div className="flex flex-col gap-4">
            <p className="text-sm text-[hsl(var(--muted-foreground))]" role="status">
              {t('auth.forgotSentNotice')}
            </p>
            <a href={`${basePath()}/`} className="text-sm text-[hsl(var(--muted-foreground))] underline underline-offset-4">
              {t('auth.backToSignIn')}
            </a>
          </div>
        ) : (
          <form className="flex flex-col gap-4" onSubmit={submit}>
            <div>
              <label className="label" htmlFor="forgot-email">{t('auth.emailLabel')}</label>
              <input
                id="forgot-email"
                name="email"
                type="email"
                autoComplete="email"
                required
                className="input"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
              />
            </div>
            <button type="submit" className="btn btn-primary w-full" disabled={forgot.isPending}>
              {forgot.isPending ? t('auth.working') : t('auth.forgotSubmitButton')}
            </button>
            <a
              href={`${basePath()}/`}
              className="text-center text-sm text-[hsl(var(--muted-foreground))] underline underline-offset-4"
            >
              {t('auth.backToSignIn')}
            </a>
          </form>
        )}
      </section>
    </div>
  );
}
