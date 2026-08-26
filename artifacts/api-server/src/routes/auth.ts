// Mode discovery, and in SaaS mode registration / sign in / sign out.
//
// GET /auth/session is what the frontend asks first: in `selfhosted` it
// always reports the implicit local user, so the login screen never renders;
// in `saas` it reports null until there is a session.
//
// Registration is invite-only. There is no open signup form, which is what
// keeps the beta at the size docs/SAAS-ARCHITECTURE.md plans for. Codes are
// minted out of band with `pnpm run invite`.

import { Router, type IRouter } from "express";
import {
  GetAuthSessionResponse,
  LoginBody,
  LoginResponse,
  RegisterBody,
  RegisterResponse,
} from "@workspace/api-zod";
import { LOCAL_USER } from "../lib/auth/local-user";
import { SESSION_COOKIE_NAME } from "../lib/auth/session";
import {
  authenticate,
  createSession,
  deleteSession,
  ensureLocalUser,
  getUserById,
  registerUser,
  resolveSession,
} from "../lib/auth/store";
import { logger } from "../lib/logger";
import { IS_SAAS, MODE } from "../lib/mode";

const router: IRouter = Router();

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
  const body = LoginBody.safeParse(req.body);
  if (!body.success) {
    res.status(401).json({ error: "Wrong email or password." });
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
