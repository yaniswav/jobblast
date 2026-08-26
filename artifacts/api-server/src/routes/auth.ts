// Mode discovery, and in SaaS mode registration / sign in / sign out.
//
// GET /auth/session is what the frontend asks first: in `selfhosted` it
// always reports the implicit local user, so the login screen never renders;
// in `saas` it reports null until there is a session.
//
// Registration is invite-only. There is no open signup form, which is what
// keeps the beta at the size docs/SAAS-ARCHITECTURE.md plans for. Codes are
// minted out of band with `pnpm run invite`.

import { Router, type IRouter, type Response } from "express";
import {
  GetAuthSessionResponse,
  LoginBody,
  LoginResponse,
  RegisterBody,
  RegisterResponse,
} from "@workspace/api-zod";
import { LOCAL_USER } from "../lib/auth/local-user";
import { createRateLimiter, type RateLimitDecision } from "../lib/auth/rate-limit";
import { SESSION_COOKIE_NAME } from "../lib/auth/session";
import {
  authenticate,
  createSession,
  deleteSession,
  ensureLocalUser,
  getUserById,
  normalizeEmail,
  registerUser,
  resolveSession,
} from "../lib/auth/store";
import { logger } from "../lib/logger";
import { IS_SAAS, MODE } from "../lib/mode";

const router: IRouter = Router();

// docs/SAAS-ARCHITECTURE.md section 2's rate-limit table. In-memory,
// single-process (v0.3 is one process), reset on restart - see
// lib/auth/rate-limit.ts for why a sliding window and not
// `express-rate-limit`.
const loginIpLimiter = createRateLimiter(15 * 60 * 1000, 10); // 10 / 15 min per IP
const loginEmailLimiter = createRateLimiter(15 * 60 * 1000, 5); // 5 / 15 min per email
const registerIpLimiter = createRateLimiter(60 * 60 * 1000, 5); // 5 / hour per IP

function tooManyRequests(res: Response, decision: RateLimitDecision): void {
  res.set("Retry-After", String(Math.ceil(decision.retryAfterMs / 1000)));
  res.status(429).json({ error: "Too many attempts. Try again later." });
}

type PublicUser = { id: string; email: string; displayName: string | null };

function toPublicUser(user: {
  id: string;
  email: string;
  displayName: string | null;
}): PublicUser {
  return { id: user.id, email: user.email, displayName: user.displayName };
}

function cookieOptions(expiresAt: Date) {
  return {
    httpOnly: true,
    sameSite: "lax" as const,
    // Enabled by default in production; a self-signed local SaaS run over
    // plain HTTP can turn it off explicitly.
    secure: process.env["SESSION_COOKIE_SECURE"] !== "0",
    path: "/",
    expires: expiresAt,
  };
}

function sessionToken(req: { cookies?: unknown }): string | undefined {
  return (req.cookies as Record<string, string> | undefined)?.[SESSION_COOKIE_NAME];
}

router.get("/auth/session", async (req, res): Promise<void> => {
  if (!IS_SAAS) {
    await ensureLocalUser();
    res.json(GetAuthSessionResponse.parse({ mode: MODE, user: LOCAL_USER }));
    return;
  }

  const token = sessionToken(req);
  const userId = token ? await resolveSession(token) : null;
  const user = userId ? await getUserById(userId) : null;
  res.json(
    GetAuthSessionResponse.parse({
      mode: MODE,
      user: user ? toPublicUser(user) : null,
    }),
  );
});

router.post("/auth/register", async (req, res): Promise<void> => {
  if (!IS_SAAS) {
    res.status(404).json({ error: "Registration is not available on a self-hosted install" });
    return;
  }
  const ipDecision = registerIpLimiter.check(req.ip ?? "unknown");
  if (!ipDecision.allowed) {
    tooManyRequests(res, ipDecision);
    return;
  }
  const body = RegisterBody.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: "Enter an invite code, an email address and a password." });
    return;
  }

  const result = await registerUser({
    email: body.data.email,
    password: body.data.password,
    inviteCode: body.data.inviteCode,
    displayName: body.data.displayName,
  });
  if (!result.ok) {
    res.status(400).json({ error: result.error });
    return;
  }

  const session = await createSession(result.user.id, {
    userAgent: req.get("user-agent"),
    ip: req.ip,
  });
  res.cookie(SESSION_COOKIE_NAME, session.token, cookieOptions(session.expiresAt));
  logger.info({ userId: result.user.id }, "Account registered");
  res
    .status(201)
    .json(RegisterResponse.parse({ mode: MODE, user: toPublicUser(result.user) }));
});

router.post("/auth/login", async (req, res): Promise<void> => {
  if (!IS_SAAS) {
    res.status(404).json({ error: "Sign in is not available on a self-hosted install" });
    return;
  }

  // Checked before parsing the body: a flood of garbage requests must not
  // skip the counter just because they fail validation.
  const ipDecision = loginIpLimiter.check(req.ip ?? "unknown");
  if (!ipDecision.allowed) {
    tooManyRequests(res, ipDecision);
    return;
  }

  const body = LoginBody.safeParse(req.body);
  if (!body.success) {
    res.status(401).json({ error: "Wrong email or password." });
    return;
  }

  // Tighter, per-email limit on top of the per-IP one: stops one attacker
  // from spreading a password-spray attack against a single address across
  // many IPs, without needing to know the address is valid first.
  const emailDecision = loginEmailLimiter.check(normalizeEmail(body.data.email));
  if (!emailDecision.allowed) {
    tooManyRequests(res, emailDecision);
    return;
  }

  const user = await authenticate(body.data.email, body.data.password);
  if (!user) {
    // Deliberately identical for an unknown address and a wrong password.
    res.status(401).json({ error: "Wrong email or password." });
    return;
  }

  const session = await createSession(user.id, {
    userAgent: req.get("user-agent"),
    ip: req.ip,
  });
  res.cookie(SESSION_COOKIE_NAME, session.token, cookieOptions(session.expiresAt));
  res.json(LoginResponse.parse({ mode: MODE, user: toPublicUser(user) }));
});

router.post("/auth/logout", async (req, res): Promise<void> => {
  const token = sessionToken(req);
  if (token) await deleteSession(token);
  res.clearCookie(SESSION_COOKIE_NAME, { path: "/" });
  res.sendStatus(204);
});

export default router;
