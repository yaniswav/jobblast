import { useState, type FormEvent } from 'react';
import { useForgotPassword } from '@workspace/api-client-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
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
    <div className="min-h-screen w-full flex items-center justify-center bg-gray-50 px-4">
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle>{t('auth.forgotTitle')}</CardTitle>
          <CardDescription>{t('auth.forgotSubtitle')}</CardDescription>
        </CardHeader>
        <CardContent>
          {!emailEnabled ? (
            <div className="flex flex-col gap-4">
              <p className="text-sm text-gray-600">{t('auth.forgotUnavailable')}</p>
              <a href={`${basePath()}/`} className="text-sm text-gray-600 underline underline-offset-4">
                {t('auth.backToSignIn')}
              </a>
            </div>
          ) : sent ? (
            <div className="flex flex-col gap-4">
              <p className="text-sm text-gray-600" role="status">
                {t('auth.forgotSentNotice')}
              </p>
              <a href={`${basePath()}/`} className="text-sm text-gray-600 underline underline-offset-4">
                {t('auth.backToSignIn')}
              </a>
            </div>
          ) : (
            <form className="flex flex-col gap-4" onSubmit={submit}>
              <div className="flex flex-col gap-2">
                <Label htmlFor="forgot-email">{t('auth.emailLabel')}</Label>
                <Input
                  id="forgot-email"
                  name="email"
                  type="email"
                  autoComplete="email"
                  required
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                />
              </div>
              <Button type="submit" disabled={forgot.isPending}>
                {forgot.isPending ? t('auth.working') : t('auth.forgotSubmitButton')}
              </Button>
              <a
                href={`${basePath()}/`}
                className="text-center text-sm text-gray-600 underline underline-offset-4"
              >
                {t('auth.backToSignIn')}
              </a>
            </form>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
