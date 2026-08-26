// The one place a request acquires a user.
//
// Applied once, at the router level in routes/index.ts, with an explicit
// allowlist of public paths - never per route, so a new route is behind auth
// by default rather than by remembering.
//
//   selfhosted: the implicit local user is injected, there is no cookie and
//               no login screen; today's experience, unchanged.
//   saas:       the jb_session cookie is resolved into a user, or the
//               request gets 401.
//
// Either way the rest of the request runs inside runWithUser(), so
// loadConfig() and the AI provider factory resolve per account.

import type { NextFunction, Request, RequestHandler, Response } from "express";
import { LOCAL_USER_ID } from "@workspace/db";
import { appOrigin, IS_SAAS } from "../mode";
import { runWithUser } from "../user-context";
import { primeUserConfig } from "../config-store";
import { isRequestOriginAllowed } from "./csrf";
import { ensureLocalUser, resolveSession } from "./store";
import { SESSION_COOKIE_NAME } from "./session";

/**
 * The account a request acts for, attached under a module-private symbol
 * rather than a declaration-merged `req.userId`: nothing outside this file
 * can set it, and route handlers must go through actingUserId().
 */
const USER_ID = Symbol.for("jobblast.userId");
type RequestWithUser = Request & { [USER_ID]?: string };

/** Paths under /api that must work without a session. */
const PUBLIC_PATHS = new Set([
  "/healthz",
  "/auth/session",
  "/auth/login",
  "/auth/register",
  "/auth/logout",
  // Password reset (G2 lot): both ends of the flow happen before anyone is
  // signed in - a session is exactly what a locked-out account does not
  // have yet.
  "/auth/forgot",
  "/auth/reset",
  // The operator's identity and data policy (routes/legal.ts): has to be
  // reachable from the login screen, before anyone has signed in.
  "/legal",
]);

function isPublic(path: string): boolean {
  return PUBLIC_PATHS.has(path.replace(/\/+$/, "") || "/");
}

export const requireUser: RequestHandler = (
  req: Request,
  res: Response,
  next: NextFunction,
): void => {
  void (async () => {
    if (!IS_SAAS) {
      if (isPublic(req.path)) {
        next();
        return;
      }
      await ensureLocalUser();
      (req as RequestWithUser)[USER_ID] = LOCAL_USER_ID;
      runWithUser(LOCAL_USER_ID, next);
      return;
    }

    // Ahead of the public-path allowlist on purpose: sign in and register
    // are unsafe methods that set a cookie, so they get the same origin
    // check as everything else.
    if (
      !isRequestOriginAllowed(
        req.method,
        req.get("origin") ?? null,
        req.get("sec-fetch-site") ?? null,
        appOrigin(),
      )
    ) {
      res.status(403).json({ error: "Cross-origin request rejected" });
      return;
    }

    if (isPublic(req.path)) {
      next();
      return;
    }

    const token = (req.cookies as Record<string, string> | undefined)?.[
      SESSION_COOKIE_NAME
    ];
    const userId = token ? await resolveSession(token) : null;
    if (!userId) {
      res.status(401).json({ error: "Not signed in" });
      return;
    }

    // Load this account's config into the request-scoped cache before any
    // handler can call loadConfig(), which is synchronous by design.
    await primeUserConfig(userId);

    (req as RequestWithUser)[USER_ID] = userId;
    runWithUser(userId, next);
  })().catch(next);
};

/**
 * The acting user, for route handlers. Throws rather than defaulting: a
 * route reached without a user is a routing bug, not a request to serve
 * somebody else's data.
 */
export function actingUserId(req: Request): string {
  const userId = (req as RequestWithUser)[USER_ID];
  if (!userId) throw new Error("No user on this request (route is not behind requireUser)");
  return userId;
}
