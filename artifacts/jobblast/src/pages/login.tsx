import { useState, type FormEvent } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { getGetAuthSessionQueryKey, useLogin, useRegister } from '@workspace/api-client-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useT } from '@/i18n';

type Mode = 'signIn' | 'register';

/**
 * Only ever rendered in SaaS mode, and only while nobody is signed in. A
 * self-hosted install reports its implicit local user from
 * GET /auth/session, so this screen never mounts there.
 */
export default function Login() {
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
    <div className="min-h-screen w-full flex items-center justify-center bg-gray-50 px-4">
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle>{mode === 'signIn' ? t('auth.signInTitle') : t('auth.registerTitle')}</CardTitle>
          <CardDescription>
            {mode === 'signIn' ? t('auth.signInSubtitle') : t('auth.registerSubtitle')}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form className="flex flex-col gap-4" onSubmit={submit}>
            {mode === 'register' && (
              <div className="flex flex-col gap-2">
                <Label htmlFor="inviteCode">{t('auth.inviteCodeLabel')}</Label>
                <Input
                  id="inviteCode"
                  name="inviteCode"
                  autoComplete="off"
                  required
                  value={inviteCode}
                  onChange={(event) => setInviteCode(event.target.value)}
                />
              </div>
            )}

            <div className="flex flex-col gap-2">
              <Label htmlFor="email">{t('auth.emailLabel')}</Label>
              <Input
                id="email"
                name="email"
                type="email"
                autoComplete="email"
                required
                value={email}
                onChange={(event) => setEmail(event.target.value)}
              />
            </div>

            <div className="flex flex-col gap-2">
              <Label htmlFor="password">{t('auth.passwordLabel')}</Label>
              <Input
                id="password"
                name="password"
                type="password"
                autoComplete={mode === 'signIn' ? 'current-password' : 'new-password'}
                required
                value={password}
                onChange={(event) => setPassword(event.target.value)}
              />
              {mode === 'register' && (
                <p className="text-xs text-gray-500">{t('auth.passwordHint')}</p>
              )}
            </div>

            {error && (
              <p role="alert" className="text-sm text-red-600">
                {error}
              </p>
            )}

            <Button type="submit" disabled={pending}>
              {pending
                ? t('auth.working')
                : mode === 'signIn'
                  ? t('auth.signInAction')
                  : t('auth.registerAction')}
            </Button>

            <button
              type="button"
              className="text-sm text-gray-600 underline underline-offset-4"
              onClick={() => {
                setMode(mode === 'signIn' ? 'register' : 'signIn');
                setError(null);
              }}
            >
              {mode === 'signIn' ? t('auth.switchToRegister') : t('auth.switchToSignIn')}
            </button>

            {/* A plain anchor, not a wouter <Link>: this screen renders
                outside the router (see App.tsx's AuthGate), since nobody is
                signed in yet. */}
            <a
              href={`${import.meta.env.BASE_URL.replace(/\/$/, '')}/privacy`}
              className="text-center text-xs text-gray-400 underline underline-offset-4"
            >
              {t('privacy.linkLabel')}
            </a>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
