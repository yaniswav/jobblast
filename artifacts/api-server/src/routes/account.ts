// GDPR account rights (v0.4 pre-beta lot, docs/SAAS-ARCHITECTURE.md
// section 8): export and deletion. saas only - a self-hosted owner already
// has full access to their own files and database, so these endpoints add
// nothing there and stay 404, same as the BYOK routes in routes/settings.ts.

import fs from "node:fs";
import { Router, type IRouter, type Response } from "express";
import { DeleteAccountBody, GetAccountExportResponse } from "@workspace/api-zod";
import { buildAccountExport } from "../lib/account-export";
import { verifyPassword } from "../lib/auth/password";
import { deleteAccount, getUserById } from "../lib/auth/store";
import { actingUserId } from "../lib/auth/middleware";
import { SESSION_COOKIE_NAME } from "../lib/auth/session";
import { logger } from "../lib/logger";
import { IS_SAAS } from "../lib/mode";
import { userDataDir } from "../lib/storage";

const router: IRouter = Router();

function requireSaas(res: Response): boolean {
  if (IS_SAAS) return true;
  res.status(404).json({ error: "Account export and deletion are not available on a self-hosted install" });
  return false;
}

router.get("/account/export", async (req, res): Promise<void> => {
  if (!requireSaas(res)) return;
  const userId = actingUserId(req);
  const data = await buildAccountExport(userId);
  res.json(GetAccountExportResponse.parse(data));
});

router.delete("/account", async (req, res): Promise<void> => {
  if (!requireSaas(res)) return;
  const userId = actingUserId(req);

  const body = DeleteAccountBody.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: "Enter your password to confirm account deletion." });
    return;
  }

  const user = await getUserById(userId);
  if (!user) {
    res.status(404).json({ error: "Account not found" });
    return;
  }

  const ok = await verifyPassword(user.passwordHash, body.data.password);
  if (!ok) {
    res.status(401).json({ error: "Wrong password." });
    return;
  }

  // The DB delete cascades everything (sessions, settings, credentials,
  // usage counters, profile, applications, documents, briefs, user_postings,
  // pending jobs - see deleteAccount()'s doc comment). Files on disk are a
  // separate concern, removed after the row is gone so a failure here never
  // leaves an orphaned account with no data.
  await deleteAccount(userId);

  try {
    await fs.promises.rm(userDataDir(userId), { recursive: true, force: true });
  } catch (err) {
    logger.error({ err, userId }, "Account deleted from the database, but its files could not be removed");
  }

  logger.info({ userId }, "Account deleted");
  res.clearCookie(SESSION_COOKIE_NAME, { path: "/" });
  res.sendStatus(204);
});

export default router;
