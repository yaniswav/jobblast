import { useState, type ChangeEvent } from 'react';
import { useMatchTrialCv, useMatchTrialCvFromPdf, type AnonymousMatchResult } from '@workspace/api-client-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Textarea } from '@/components/ui/textarea';
import { useT } from '@/i18n';

const basePath = () => import.meta.env.BASE_URL.replace(/\/$/, '');

function errorStatus(err: unknown): number | undefined {
  return err && typeof err === 'object' && 'status' in err ? (err as { status?: number }).status : undefined;
}

/**
 * Only ever rendered in SaaS mode, and only while nobody is signed in
 * (App.tsx's AuthGate checks the path before this mounts, the same way it
 * does for pages/login.tsx, forgot-password.tsx and reset-password.tsx).
 * Reached from the "try it with your CV" link on the login screen.
 *
 * Zero AI, zero persistence, on the server (routes/trial.ts,
 * lib/anonymous-match.ts) - this component only ever holds the CV text or
 * file in local React state, and drops it the moment the request that used
 * it settles.
 */
export default function Try() {
  const t = useT();
  const [cvText, setCvText] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<AnonymousMatchResult | null>(null);

  const matchText = useMatchTrialCv();
  const matchPdf = useMatchTrialCvFromPdf();
  const pending = matchText.isPending || matchPdf.isPending;

  const handleFail = (err: unknown) => {
    const status = errorStatus(err);
    setError(status === 429 ? t('try.errorRateLimited') : status === 400 ? t('try.errorInvalidCv') : t('try.errorGeneric'));
  };

  const handleFile = (event: ChangeEvent<HTMLInputElement>) => {
    const picked = event.target.files?.[0];
    event.target.value = '';
    if (!picked) return;
    if (picked.type !== 'application/pdf') {
      setError(t('try.errorPdfOnly'));
      return;
    }
    setFile(picked);
    setCvText('');
    setError(null);
  };

  const submit = () => {
    setError(null);
    if (file) {
      matchPdf.mutate({ data: { file } }, { onSuccess: setResult, onError: handleFail });
      return;
    }
    matchText.mutate({ data: { cvText } }, { onSuccess: setResult, onError: handleFail });
  };

  const reset = () => {
    setCvText('');
    setFile(null);
    setError(null);
    setResult(null);
  };

  const canSubmit = !pending && (file !== null || cvText.trim().length >= 30);

  return (
    <div className="min-h-screen w-full flex items-center justify-center bg-gray-50 px-4 py-10">
      <Card className="w-full max-w-2xl">
        <CardHeader>
          <CardTitle>{t('try.title')}</CardTitle>
          <CardDescription>{t('try.subtitle')}</CardDescription>
        </CardHeader>
        <CardContent>
          {!result ? (
            <div className="flex flex-col gap-4">
              <p className="text-xs text-gray-500" data-testid="text-try-privacy-notice">
                {t('try.privacyNotice')}
              </p>

              <div className="flex flex-col gap-2">
                <Textarea
                  className="min-h-[220px]"
                  placeholder={t('try.textareaPlaceholder')}
                  value={cvText}
                  onChange={(event) => {
                    setCvText(event.target.value);
                    setFile(null);
                  }}
                  disabled={pending || file !== null}
                  data-testid="textarea-try-cv"
                />
                <div className="flex items-center justify-between gap-3">
                  <label className="text-sm text-gray-600 underline underline-offset-4 cursor-pointer">
                    {file ? file.name : t('try.uploadPdfLabel')}
                    <input
                      type="file"
                      accept="application/pdf"
                      className="hidden"
                      onChange={handleFile}
                      disabled={pending}
                      data-testid="input-try-cv-file"
                    />
                  </label>
                  {file && (
                    <button
                      type="button"
                      className="text-xs text-gray-400 underline underline-offset-4"
                      onClick={() => setFile(null)}
                      data-testid="button-try-clear-file"
                    >
                      {t('try.clearFile')}
                    </button>
                  )}
                </div>
              </div>

              {error && (
                <p role="alert" className="text-sm text-red-600" data-testid="text-try-error">
                  {error}
                </p>
              )}

              <Button type="button" disabled={!canSubmit} onClick={submit} data-testid="button-try-submit">
                {pending ? t('try.working') : t('try.submitButton')}
              </Button>

              <a href={`${basePath()}/`} className="text-center text-sm text-gray-600 underline underline-offset-4">
                {t('auth.backToSignIn')}
              </a>
            </div>
          ) : (
            <div className="flex flex-col gap-5" data-testid="panel-try-results">
              {result.matches.length > 0 ? (
                <>
                  <div className="grid gap-3">
                    {result.matches.map((match, index) => (
                      <div key={index} className="rounded-lg border border-gray-200 p-4" data-testid={`card-try-match-${index}`}>
                        <div className="flex items-start justify-between gap-3">
                          <div>
                            <div className="font-bold">{match.title}</div>
                            <div className="text-sm text-gray-500">
                              {match.company} · {match.location} · {match.workMode}
                            </div>
                          </div>
                          <Badge variant="secondary">{t('try.matchScore', { score: match.relevanceScore })}</Badge>
                        </div>
                        <p className="mt-3 text-sm text-gray-600">{match.descriptionExcerpt}</p>
                      </div>
                    ))}
                  </div>
                  {result.totalMatches > result.matches.length && (
                    <p className="text-sm text-gray-600" data-testid="text-try-more-matches">
                      {t('try.moreMatches', { count: result.totalMatches - result.matches.length })}
                    </p>
                  )}
                </>
              ) : (
                <p className="text-sm text-gray-600" data-testid="text-try-pool-too-small">
                  {t('try.poolTooSmall')}
                </p>
              )}

              <div className="rounded-lg bg-gray-100 p-4 text-sm text-gray-700">{t('try.signupPitch')}</div>

              <div className="flex flex-col gap-2">
                <Button asChild data-testid="link-try-create-account">
                  <a href={`${basePath()}/`}>{t('try.createAccountButton')}</a>
                </Button>
                <button
                  type="button"
                  className="text-sm text-gray-600 underline underline-offset-4"
                  onClick={reset}
                  data-testid="button-try-again"
                >
                  {t('try.tryAnother')}
                </button>
              </div>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
