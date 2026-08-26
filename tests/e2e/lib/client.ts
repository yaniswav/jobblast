// A minimal fetch-based HTTP client for the E2E suite - no supertest, no
// browser, no cookie-jar library. Node's global fetch (Node >= 18) is enough:
// it lets a caller set an arbitrary "Origin" header (browsers forbid this,
// undici does not), which is exactly what the CSRF check in
// artifacts/api-server/src/lib/auth/csrf.ts needs on every unsafe request.
//
// Cookies are handled by hand: each `Session` remembers the last `jb_session`
// value it was handed and replays it on every later call, the same way a
// browser tab would. There is one `Session` object per simulated "browser":
// specs create a fresh one per account so two accounts never share state.

export const BASE_URL = process.env["E2E_BASE_URL"] ?? "http://localhost:8080";
const API_BASE = `${BASE_URL}/api`;

const UNSAFE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const SESSION_COOKIE_NAME = "jb_session";

export type Session = {
  cookie: string | null;
};

/** A fresh, signed-out "browser" - no cookie yet. */
export function newSession(): Session {
  return { cookie: null };
}

export type ApiResult<T> = {
  status: number;
  data: T;
  headers: Headers;
};

/**
 * Calls one `/api/*` endpoint. `body`, when present, is sent as JSON.
 * Captures any `Set-Cookie: jb_session=...` from the response onto `session`
 * and replays whatever cookie `session` is currently carrying on the request
 * - so a caller never touches headers directly, just passes the same
 * `Session` object through a whole user journey.
 */
export async function apiCall<T = unknown>(
  session: Session,
  method: string,
  path: string,
  body?: unknown,
): Promise<ApiResult<T>> {
  const headers: Record<string, string> = {};
  if (body !== undefined) headers["Content-Type"] = "application/json";
  // Only unsafe methods are origin-checked (csrf.ts's SAFE_METHODS), but
  // sending it on every request is harmless and one less thing to get wrong.
  if (UNSAFE_METHODS.has(method.toUpperCase())) headers["Origin"] = BASE_URL;
  if (session.cookie) headers["Cookie"] = `${SESSION_COOKIE_NAME}=${session.cookie}`;

  const res = await fetch(`${API_BASE}${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

  const setCookies = typeof res.headers.getSetCookie === "function" ? res.headers.getSetCookie() : [];
  const sessionCookie = setCookies.find((c) => c.startsWith(`${SESSION_COOKIE_NAME}=`));
  if (sessionCookie) {
    const value = sessionCookie.slice(SESSION_COOKIE_NAME.length + 1).split(";")[0] ?? "";
    // res.clearCookie() (logout, reset) sets the cookie to an empty value -
    // treat that the same as "signed out" rather than replaying an empty
    // Cookie header forever.
    session.cookie = value.length > 0 ? value : null;
  }

  const text = await res.text();
  const data = (text.length > 0 ? JSON.parse(text) : undefined) as T;
  return { status: res.status, data, headers: res.headers };
}

export const get = <T = unknown>(session: Session, path: string) => apiCall<T>(session, "GET", path);
export const post = <T = unknown>(session: Session, path: string, body?: unknown) =>
  apiCall<T>(session, "POST", path, body);
export const put = <T = unknown>(session: Session, path: string, body?: unknown) =>
  apiCall<T>(session, "PUT", path, body);
export const patch = <T = unknown>(session: Session, path: string, body?: unknown) =>
  apiCall<T>(session, "PATCH", path, body);
export const del = <T = unknown>(session: Session, path: string, body?: unknown) =>
  apiCall<T>(session, "DELETE", path, body);

/** A stable, valid-looking test password that clears validatePassword()'s length and common-password checks. */
export function testPassword(label: string): string {
  return `E2e-${label}-${Math.random().toString(36).slice(2, 10)}-Passw0rd!`;
}

/** A unique test email so runs never collide, even against a stack left up between local runs. */
export function testEmail(label: string): string {
  const unique = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  return `e2e-${label}-${unique}@example.invalid`;
}
