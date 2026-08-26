import { useState, type FormEvent } from 'react';
import { useResetPassword } from '@workspace/api-client-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
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
    <div className="min-h-screen w-full flex items-center justify-center bg-gray-50 px-4">
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle>{t('auth.resetTitle')}</CardTitle>
          <CardDescription>{t('auth.resetSubtitle')}</CardDescription>
        </CardHeader>
        <CardContent>
          {!emailEnabled ? (
            <div className="flex flex-col gap-4">
              <p className="text-sm text-gray-600">{t('auth.forgotUnavailable')}</p>
              <a href={`${basePath()}/`} className="text-sm text-gray-600 underline underline-offset-4">
                {t('auth.backToSignIn')}
              </a>
            </div>
          ) : !token ? (
            <div className="flex flex-col gap-4">
              <p className="text-sm text-gray-600">{t('auth.resetMissingToken')}</p>
              <a href={`${basePath()}/forgot`} className="text-sm text-gray-600 underline underline-offset-4">
                {t('auth.forgotTitle')}
              </a>
            </div>
          ) : done ? (
            <div className="flex flex-col gap-4">
              <p className="text-sm text-gray-600" role="status">
                {t('auth.resetSuccessNotice')}
              </p>
              <a href={`${basePath()}/`} className="text-sm text-gray-600 underline underline-offset-4">
                {t('auth.backToSignIn')}
              </a>
            </div>
          ) : (
            <form className="flex flex-col gap-4" onSubmit={submit}>
              <div className="flex flex-col gap-2">
                <Label htmlFor="reset-new-password">{t('auth.resetNewPasswordLabel')}</Label>
                <Input
                  id="reset-new-password"
                  name="newPassword"
                  type="password"
                  autoComplete="new-password"
                  required
                  value={newPassword}
                  onChange={(event) => setNewPassword(event.target.value)}
                />
                <p className="text-xs text-gray-500">{t('auth.passwordHint')}</p>
              </div>

              {error && (
                <p role="alert" className="text-sm text-red-600">
                  {error}
                </p>
              )}

              <Button type="submit" disabled={reset.isPending}>
                {reset.isPending ? t('auth.working') : t('auth.resetSubmitButton')}
              </Button>
            </form>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
