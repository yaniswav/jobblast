// CSRF, on top of the session cookie's SameSite=Lax.
//
// Lax already blocks cross-site form posts; this rejects any unsafe method
// whose Origin is absent or does not match APP_ORIGIN, also accepting
// Sec-Fetch-Site: same-origin from browsers that send it. Two dozen lines,
// no token plumbing through the orval-generated client, and the decision
// itself is a pure predicate so it is testable as a table.
//
// Only enforced in `saas`: self-hosted has no cookie to ride.

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

export function isRequestOriginAllowed(
  method: string,
  origin: string | null,
  secFetchSite: string | null,
  appOrigin: string | null,
): boolean {
  if (SAFE_METHODS.has(method.toUpperCase())) return true;
  // Nothing to compare against: refuse rather than wave everything through.
  if (!appOrigin) return false;
  if (secFetchSite === "same-origin") return true;
  if (!origin) return false;
  return origin.replace(/\/+$/, "") === appOrigin.replace(/\/+$/, "");
}
