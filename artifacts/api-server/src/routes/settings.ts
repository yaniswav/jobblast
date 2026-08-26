// AI provider setup wizard + automation toggles (Settings page).
//
// Every read/write of jobblast.config.json goes through lib/config-store.ts
// - this file only validates the wire shape, decides whether a requested
// provider is actually usable on this machine, and calls the store.

import { Router, type IRouter } from "express";
import {
  GetSettingsResponse,
  ListAiProviderOptionsResponse,
  TestAiProviderResponse,
  UpdateSettingsBody,
  UpdateSettingsResponse,
} from "@workspace/api-zod";
import { readAiSettings, readAutomations, writeAiSettings, writeAutomations } from "../lib/config-store";
import { listAiProviderOptions } from "../lib/ai/provider-options";
import { getTextProvider, resetProviderCache } from "../lib/ai/provider";

const router: IRouter = Router();

function currentState() {
  return { ai: readAiSettings(), ...readAutomations() };
}

router.get("/settings/ai/options", async (_req, res) => {
  const options = await listAiProviderOptions();
  res.json(ListAiProviderOptionsResponse.parse(options));
});

router.get("/settings", (_req, res) => {
  res.json(GetSettingsResponse.parse(currentState()));
});

router.put("/settings", async (req, res): Promise<void> => {
  const body = UpdateSettingsBody.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: body.error.message });
    return;
  }

  const requestedProvider = body.data.ai?.provider;
  if (requestedProvider !== undefined) {
    const options = await listAiProviderOptions();
    const chosen = options.find((option) => option.id === requestedProvider);
    if (!chosen?.available) {
      res.status(400).json({
        error: `Provider "${requestedProvider}" is not available on this machine. ${chosen?.detail ?? ""}`.trim(),
      });
      return;
    }
  }

  try {
    if (body.data.ai) writeAiSettings(body.data.ai);
    if (body.data.gmailSync || body.data.aiScout || body.data.notionInbox) {
      writeAutomations({
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

export default router;
