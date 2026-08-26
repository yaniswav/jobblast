// AI provider setup wizard + automation toggles (Settings page).
//
// Every read/write of jobblast.config.json goes through lib/config-store.ts
// - this file only validates the wire shape, decides whether a requested
// provider is actually usable on this machine, and calls the store.

import { Router, type IRouter, type Response } from "express";
import {
  DeleteAiCredentialParams,
  GetSettingsResponse,
  ListAiCredentialsResponse,
  ListAiProviderOptionsResponse,
  SaveAiCredentialBody,
  SaveAiCredentialParams,
  SaveAiCredentialResponse,
  TestAiCredentialBody,
  TestAiCredentialParams,
  TestAiCredentialResponse,
  TestAiProviderResponse,
  UpdateSettingsBody,
  UpdateSettingsResponse,
} from "@workspace/api-zod";
import { readAiSettings, readAutomations, writeAiSettings, writeAutomations } from "../lib/config-store";
import { listAiProviderOptions } from "../lib/ai/provider-options";
import { getTextProvider, resetProviderCache } from "../lib/ai/provider";
import { testByokCredential } from "../lib/ai/byok-test";
import { actingUserId } from "../lib/auth/middleware";
import { BYOK_PROVIDERS } from "../lib/config";
import { IS_SAAS } from "../lib/mode";
import {
  decryptCredential,
  deleteCredential,
  listCredentialStatuses,
  recordCredentialTestResult,
  storeCredential,
} from "../lib/repo/ai-credentials";

const router: IRouter = Router();

function currentState() {
  return { ai: readAiSettings(), ...readAutomations() };
}

/** BYOK only exists in saas: everywhere else the key lives in .env, not the database. */
function requireSaas(res: Response): boolean {
  if (IS_SAAS) return true;
  res.status(404).json({ error: "BYOK credentials are not available on a self-hosted install" });
  return false;
}

router.get("/settings/ai/options", async (req, res) => {
  const options = await listAiProviderOptions(actingUserId(req));
  res.json(ListAiProviderOptionsResponse.parse(options));
});

router.get("/settings", (_req, res) => {
  res.json(GetSettingsResponse.parse(currentState()));
});

router.put("/settings", async (req, res): Promise<void> => {
  const userId = actingUserId(req);
  const body = UpdateSettingsBody.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: body.error.message });
    return;
  }

  const requestedProvider = body.data.ai?.provider;
  if (requestedProvider !== undefined) {
    const options = await listAiProviderOptions(userId);
    const chosen = options.find((option) => option.id === requestedProvider);
    if (!chosen?.available) {
      res.status(400).json({
        error: `Provider "${requestedProvider}" is not available on this machine. ${chosen?.detail ?? ""}`.trim(),
      });
      return;
    }
  }

  try {
    if (body.data.ai) await writeAiSettings(body.data.ai);
    if (body.data.gmailSync || body.data.aiScout || body.data.notionInbox) {
      await writeAutomations({
        gmailSync: body.data.gmailSync,
        aiScout: body.data.aiScout,
        notionInbox: body.data.notionInbox,
      });
    }
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
    return;
  }

  res.json(UpdateSettingsResponse.parse(currentState()));
});

router.post("/settings/ai/test", async (_req, res) => {
  const startedAt = Date.now();

  // Force a fresh build from the currently saved config: a prior failed
  // pass may have switched the process to no-AI mode (see provider.ts
  // `disableAi`), and the whole point of the Test button is a real, current
  // attempt rather than a cached "AI is off" verdict.
  resetProviderCache();

  const provider = getTextProvider();
  if (!provider) {
    res.json(
      TestAiProviderResponse.parse({
        ok: false,
        latencyMs: Date.now() - startedAt,
        error: 'No AI provider is active (ai.provider is "none", or the configured provider is unavailable).',
      }),
    );
    return;
  }

  try {
    await provider.generateText("Reply with exactly: OK", { timeoutMs: 60_000 });
    res.json(TestAiProviderResponse.parse({ ok: true, latencyMs: Date.now() - startedAt, error: null }));
  } catch (err) {
    res.json(
      TestAiProviderResponse.parse({
        ok: false,
        latencyMs: Date.now() - startedAt,
        error: (err as Error).message,
      }),
    );
  }
});

// ---------------------------------------------------------------------------
// BYOK credentials (saas only). Never returns the key itself in any form -
// see lib/crypto/byok.ts and lib/repo/ai-credentials.ts.
// ---------------------------------------------------------------------------

router.get("/settings/ai/credentials", async (req, res): Promise<void> => {
  if (!requireSaas(res)) return;
  const statuses = await listCredentialStatuses(actingUserId(req), BYOK_PROVIDERS);
  res.json(ListAiCredentialsResponse.parse(statuses));
});

router.put("/settings/ai/credentials/:provider", async (req, res): Promise<void> => {
  if (!requireSaas(res)) return;
  const params = SaveAiCredentialParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const body = SaveAiCredentialBody.safeParse(req.body);
  if (!body.success || body.data.apiKey.trim().length === 0) {
    res.status(400).json({ error: "An API key is required." });
    return;
  }

  const status = await storeCredential(actingUserId(req), params.data.provider, body.data.apiKey.trim());
  // A newly saved key invalidates any process-wide no-AI fallback from a
  // previous stale credential, same as writeAiSettings/writeAutomations.
  resetProviderCache();
  res.json(SaveAiCredentialResponse.parse(status));
});

router.delete("/settings/ai/credentials/:provider", async (req, res): Promise<void> => {
  if (!requireSaas(res)) return;
  const params = DeleteAiCredentialParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  await deleteCredential(actingUserId(req), params.data.provider);
  resetProviderCache();
  res.sendStatus(204);
});

router.post("/settings/ai/credentials/:provider/test", async (req, res): Promise<void> => {
  if (!requireSaas(res)) return;
  const params = TestAiCredentialParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const provider = params.data.provider;
  const userId = actingUserId(req);

  const body = TestAiCredentialBody.safeParse(req.body ?? {});
  const candidateKey = body.success ? body.data.apiKey?.trim() : undefined;

  // A candidate key not yet saved: test it, but never persist it or the
  // result - saving is a separate, explicit action (PUT), never a side
  // effect of testing.
  if (candidateKey) {
    const result = await testByokCredential(provider, candidateKey);
    res.json(TestAiCredentialResponse.parse(result));
    return;
  }

  const storedKey = await decryptCredential(userId, provider);
  if (!storedKey) {
    res.status(400).json({ error: "No key is saved for this provider yet." });
    return;
  }

  const result = await testByokCredential(provider, storedKey);
  await recordCredentialTestResult(userId, provider, { ok: result.ok, error: result.error });
  res.json(TestAiCredentialResponse.parse(result));
});

export default router;
