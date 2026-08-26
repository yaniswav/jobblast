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
  ForgotPasswordBody,
  GetAuthSessionResponse,
  LoginBody,
  LoginResponse,
  RegisterBody,
  RegisterResponse,
  ResetPasswordBody,
} from "@workspace/api-zod";
import { validatePassword } from "../lib/auth/password";
import { LOCAL_USER } from "../lib/auth/local-user";
import { createRateLimiter, type RateLimitDecision } from "../lib/auth/rate-limit";
import { SESSION_COOKIE_NAME } from "../lib/auth/session";
import {
  authenticate,
  consumePasswordResetToken,
  createPasswordResetToken,
  createSession,
  deleteSession,
  ensureLocalUser,
  getUserByEmail,
  getUserById,
  normalizeEmail,
  registerUser,
  resetPassword,
  resolveSession,
} from "../lib/auth/store";
import { isEmailEnabled, resetPasswordEmail, resolveEmailLocale, sendEmail } from "../lib/email";
import { logger } from "../lib/logger";
import { appOrigin, IS_SAAS, MODE } from "../lib/mode";

const router: IRouter = Router();

// docs/SAAS-ARCHITECTURE.md section 2's rate-limit table. In-memory,
// single-process (v0.3 is one process), reset on restart - see
// lib/auth/rate-limit.ts for why a sliding window and not
// `express-rate-limit`.
const loginIpLimiter = createRateLimiter(15 * 60 * 1000, 10); // 10 / 15 min per IP
const loginEmailLimiter = createRateLimiter(15 * 60 * 1000, 5); // 5 / 15 min per email
const registerIpLimiter = createRateLimiter(60 * 60 * 1000, 5); // 5 / hour per IP
// docs/SAAS-ARCHITECTURE.md section 2's "POST /auth/password-reset" row: 3 /
// hour per IP and per email. /auth/reset gets a generous, IP-only limiter on
// top - its tokens are 256-bit and unguessable, so this is defense in depth
// against a scripted flood, not the primary control.
const forgotIpLimiter = createRateLimiter(60 * 60 * 1000, 3); // 3 / hour per IP
const forgotEmailLimiter = createRateLimiter(60 * 60 * 1000, 3); // 3 / hour per email
const resetIpLimiter = createRateLimiter(60 * 60 * 1000, 20); // 20 / hour per IP

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
    // Self-hosted never shows a "forgot password" link: there is no login
    // screen and no password to reset, whatever an operator may have left
    // set in JOBBLAST_SMTP_* by accident.
    res.json(GetAuthSessionResponse.parse({ mode: MODE, user: LOCAL_USER, emailEnabled: false }));
    return;
  }

  const token = sessionToken(req);
  const userId = token ? await resolveSession(token) : null;
  const user = userId ? await getUserById(userId) : null;
  res.json(
    GetAuthSessionResponse.parse({
      mode: MODE,
      user: user ? toPublicUser(user) : null,
      emailEnabled: isEmailEnabled(),
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
    .json(
      RegisterResponse.parse({
        mode: MODE,
        user: toPublicUser(result.user),
        emailEnabled: isEmailEnabled(),
      }),
    );
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
  res.json(LoginResponse.parse({ mode: MODE, user: toPublicUser(user), emailEnabled: isEmailEnabled() }));
});

router.post("/auth/logout", async (req, res): Promise<void> => {
  const token = sessionToken(req);
  if (token) await deleteSession(token);
  res.clearCookie(SESSION_COOKIE_NAME, { path: "/" });
  res.sendStatus(204);
});

/**
 * Always 204: whether the address is unknown, belongs to an account, or the
 * email transport is off, the response is identical, so this endpoint never
 * confirms which addresses are registered (docs/SAAS-ARCHITECTURE.md
 * section 2's login handler already makes the same trade-off, and for the
 * same reason). A send failure is logged, not surfaced - the caller cannot
 * be told without leaking whether the account existed.
 */
router.post("/auth/forgot", async (req, res): Promise<void> => {
  if (!IS_SAAS) {
    res.status(404).json({ error: "Password reset is not available on a self-hosted install" });
    return;
  }

  const ipDecision = forgotIpLimiter.check(req.ip ?? "unknown");
  if (!ipDecision.allowed) {
    tooManyRequests(res, ipDecision);
    return;
  }

  const body = ForgotPasswordBody.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: "Enter an email address." });
    return;
  }

  const email = normalizeEmail(body.data.email);
  const emailDecision = forgotEmailLimiter.check(email);
  if (!emailDecision.allowed) {
    tooManyRequests(res, emailDecision);
    return;
  }

  void (async () => {
    try {
      const user = await getUserByEmail(email);
      // No account, or the email transport cannot actually deliver anything
      // right now: stop here, silently. Both look identical from the
      // outside, which is the point.
      if (!user || !isEmailEnabled()) return;

      const { token } = await createPasswordResetToken(user.id);
      const origin = appOrigin() ?? "";
      const link = `${origin}/reset?token=${encodeURIComponent(token)}`;
      const content = resetPasswordEmail(resolveEmailLocale(user.locale), link);
      await sendEmail({ to: user.email, subject: content.subject, text: content.text, html: content.html });
    } catch (err) {
      logger.error({ err }, "Forgot-password: could not send the reset email");
    }
  })();

  res.sendStatus(204);
});

router.post("/auth/reset", async (req, res): Promise<void> => {
  if (!IS_SAAS) {
    res.status(404).json({ error: "Password reset is not available on a self-hosted install" });
    return;
  }

  const ipDecision = resetIpLimiter.check(req.ip ?? "unknown");
  if (!ipDecision.allowed) {
    tooManyRequests(res, ipDecision);
    return;
  }

  const body = ResetPasswordBody.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: "Enter the reset link's token and a new password." });
    return;
  }

  const passwordProblem = validatePassword(body.data.newPassword);
  if (passwordProblem) {
    res.status(400).json({ error: passwordProblem });
    return;
  }

  const consumed = await consumePasswordResetToken(body.data.token);
  if (!consumed) {
    res.status(400).json({ error: "This reset link is invalid, expired or has already been used." });
    return;
  }

  await resetPassword(consumed.userId, body.data.newPassword);

  // Every session on the account was just invalidated, including whichever
  // one this request happened to be carrying - clear it here too so the
  // browser does not keep sending a cookie the server already dropped.
  res.clearCookie(SESSION_COOKIE_NAME, { path: "/" });
  logger.info({ userId: consumed.userId }, "Password reset, every session on the account invalidated");
  res.sendStatus(204);
});

export default router;
