// One-off "does this key actually work" calls for the BYOK Settings UI
// (POST /settings/ai/credentials/{provider}/test).
//
// Deliberately independent from provider.ts's module-scope `built` /
// `disabledReason` singleton, which docs/SAAS-ARCHITECTURE.md section 5
// calls out as the thing lot D replaces with a per-user cache (a wrong key
// for one account must never disable AI for another). A BYOK test call never
// touches that cache: it builds a throwaway client from the key handed to
// it, makes one small real call, and returns the outcome. The key is never
// logged.
//
// openai-compatible reuses providers/openai-compatible.ts's
// `resolveProviderSettings` for base URL / model / temperature (the
// non-secret bits, which in saas mode already live in the account's own
// user_settings.config - see lib/config-store.ts), but never that module's
// own env-var key lookup: the key here comes straight from the caller.

import Anthropic from "@anthropic-ai/sdk";
import { loadConfig, type ByokProviderName } from "../config";
import { resolveProviderSettings } from "./providers/openai-compatible";

export type ByokTestResult = { ok: boolean; latencyMs: number; error: string | null };

const TEST_PROMPT = "Reply with exactly: OK";
const TEST_TIMEOUT_MS = 15_000;
const TEST_MAX_TOKENS = 8;

async function testAnthropicKey(apiKey: string): Promise<void> {
  const { anthropicApi } = loadConfig().ai;
  const client = new Anthropic({ apiKey });
  const response = await client.messages.create(
    {
      model: anthropicApi.model,
      max_tokens: TEST_MAX_TOKENS,
      messages: [{ role: "user", content: TEST_PROMPT }],
    },
    { timeout: TEST_TIMEOUT_MS },
  );

  if (response.stop_reason === "refusal") {
    throw new Error("Anthropic API declined the test request");
  }
  const text = response.content
    .filter((block): block is Anthropic.TextBlock => block.type === "text")
    .map((block) => block.text)
    .join("");
  if (text.trim().length === 0) {
    throw new Error(`Anthropic API returned no text (stop_reason=${response.stop_reason ?? "unknown"})`);
  }
}

type ChatCompletion = {
  choices?: { message?: { content?: string | null } }[];
  error?: { message?: string } | string;
};

async function testOpenAiCompatibleKey(apiKey: string): Promise<void> {
  const { baseUrl, model, temperature } = resolveProviderSettings("openai-compatible");

  const body: Record<string, unknown> = {
    model,
    messages: [{ role: "user", content: TEST_PROMPT }],
    max_tokens: TEST_MAX_TOKENS,
  };
  if (temperature !== null) body["temperature"] = temperature;

  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(TEST_TIMEOUT_MS),
  });

  const raw = await response.text();
  if (!response.ok) {
    throw new Error(`openai-compatible returned HTTP ${response.status}: ${raw.slice(0, 300)}`);
  }

  let parsed: ChatCompletion;
  try {
    parsed = JSON.parse(raw) as ChatCompletion;
  } catch (err) {
    throw new Error(`openai-compatible returned non-JSON output: ${raw.slice(0, 300)}`, { cause: err });
  }

  if (parsed.error) {
    const message = typeof parsed.error === "string" ? parsed.error : (parsed.error.message ?? "unknown error");
    throw new Error(`openai-compatible reported an error: ${message}`);
  }

  const content = parsed.choices?.[0]?.message?.content;
  if (typeof content !== "string" || content.trim().length === 0) {
    throw new Error("openai-compatible returned no message content");
  }
}

/** Makes one small real call to `provider` using `apiKey` directly. Never logs the key. */
export async function testByokCredential(
  provider: ByokProviderName,
  apiKey: string,
): Promise<ByokTestResult> {
  const startedAt = Date.now();
  try {
    if (provider === "anthropic-api") await testAnthropicKey(apiKey);
    else await testOpenAiCompatibleKey(apiKey);
    return { ok: true, latencyMs: Date.now() - startedAt, error: null };
  } catch (err) {
    return { ok: false, latencyMs: Date.now() - startedAt, error: (err as Error).message };
  }
}
