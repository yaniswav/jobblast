// Shared fetch helpers for the newer, unofficial/scraped job sources
// (yourator.ts, job104.ts, tokyodev.ts, japandev.ts, himalayas.ts,
// remoteok.ts, remotive.ts, arbeitnow.ts). Centralizes the "be polite"
// etiquette the brief asked for: an honest, identifiable User-Agent and a
// bounded timeout so a slow/unresponsive source can't hang a refresh cycle.
//
// The older sources (adzuna.ts, francetravail.ts, greenhouse.ts, lever.ts)
// call fetch() directly and are left untouched - this helper is additive,
// not a refactor of existing working code.

import { loadConfig } from "../config";

// Honest, identifiable User-Agent. The contact e-mail comes from
// `contact.email` in the account's configuration; without one we still
// identify the client, just without a contact address.
//
// Resolved per call, not once at module load: in `saas` the configuration is
// per account and reading it outside a request context is an error by
// design, so a module-level read would throw before the process even starts.
export function userAgent(): string {
  const contactEmail = loadConfig().contact.email.trim();
  return contactEmail
    ? `JobBlast personal job tracker (contact: ${contactEmail})`
    : "JobBlast personal job tracker";
}

const DEFAULT_TIMEOUT_MS = 10_000;

/** fetch() with an honest User-Agent and a default 10s timeout. */
export function politeFetch(url: string, init: RequestInit = {}, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<Response> {
  const headers = new Headers(init.headers);
  if (!headers.has("User-Agent")) headers.set("User-Agent", userAgent());
  return fetch(url, {
    ...init,
    headers,
    signal: init.signal ?? AbortSignal.timeout(timeoutMs),
  });
}

/** Simple delay used to throttle sequential requests against a single host. */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
