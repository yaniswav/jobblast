// `openai-compatible` provider (plus the `ollama` and `lmstudio` presets):
// a raw fetch to an OpenAI Chat Completions endpoint.
//
// One tiny HTTP call covers OpenAI, Ollama, LM Studio, OpenRouter, Mistral,
// Groq, vLLM and anything else that speaks POST {baseUrl}/chat/completions.
// No SDK, no Anthropic code in this file (providers/anthropic-api.ts is the
// mirror image and contains no OpenAI-shaped code).
//
// Text only: there are no tools here, so getAgentProvider() returns null and
// AI Scout / Notion Inbox stay off on these providers.

import { loadConfig, type AiProviderName } from "../../config";
import { ProviderUnavailableError } from "../errors";
import type { TextProvider } from "../provider";
import { stripCodeFence } from "./shared";

type Preset = { baseUrl: string; apiKeyEnv: string; model: string };

/**
 * Defaults per provider alias. `ollama` and `lmstudio` are just this provider
 * pointed at a local server with no API key, which is the "free, fully local,
 * nothing leaves your machine" option.
 */
const PRESETS: Record<"openai-compatible" | "ollama" | "lmstudio", Preset> = {
  "openai-compatible": {
    baseUrl: "https://api.openai.com/v1",
    apiKeyEnv: "OPENAI_API_KEY",
    model: "gpt-4o-mini",
  },
  ollama: {
    baseUrl: "http://localhost:11434/v1",
    apiKeyEnv: "",
    model: "llama3.1",
  },
  lmstudio: {
    baseUrl: "http://localhost:1234/v1",
    apiKeyEnv: "",
    model: "local-model",
  },
};

type Resolved = Preset & { temperature: number | null };

/** Config wins key by key; anything left out comes from the alias preset. */
function resolve(provider: AiProviderName): Resolved {
  const preset = PRESETS[provider as keyof typeof PRESETS] ?? PRESETS["openai-compatible"];
  const cfg = loadConfig().ai.openaiCompatible;

  return {
    baseUrl: (cfg.baseUrl ?? preset.baseUrl).replace(/\/+$/, ""),
    apiKeyEnv: cfg.apiKeyEnv ?? preset.apiKeyEnv,
    model: cfg.model ?? preset.model,
    temperature: cfg.temperature ?? null,
  };
}

type ChatCompletion = {
  choices?: { message?: { content?: string | null } }[];
  error?: { message?: string } | string;
};

/** True for the "nothing is listening on that port" family of fetch failures. */
function isConnectionRefused(err: unknown): boolean {
  const cause = (err as { cause?: NodeJS.ErrnoException } | undefined)?.cause;
  const code = cause?.code ?? (err as NodeJS.ErrnoException | undefined)?.code;
  return code === "ECONNREFUSED" || code === "ENOTFOUND" || code === "EAI_AGAIN";
}

export function createOpenAiCompatibleProvider(provider: AiProviderName): TextProvider {
  return {
    name: provider,

    async generateText(prompt, opts = {}) {
      const { baseUrl, apiKeyEnv, model, temperature } = resolve(provider);
      const timeoutMs = opts.timeoutMs ?? loadConfig().ai.timeoutMs;

      const headers: Record<string, string> = { "content-type": "application/json" };
      if (apiKeyEnv.trim().length > 0) {
        const apiKey = process.env[apiKeyEnv.trim()];
        if (!apiKey || apiKey.trim().length === 0) {
          throw new ProviderUnavailableError(
            provider,
            `${apiKeyEnv} is not set (add it to .env, or set ai.openaiCompatible.apiKeyEnv to "" for a local server that needs no key)`,
          );
        }
        headers["authorization"] = `Bearer ${apiKey}`;
      }

      const body: Record<string, unknown> = {
        model,
        messages: [{ role: "user", content: prompt }],
      };
      if (opts.maxTokens) body["max_tokens"] = opts.maxTokens;
      if (temperature !== null) body["temperature"] = temperature;

      const url = `${baseUrl}/chat/completions`;

      let response: Response;
      try {
        response = await fetch(url, {
          method: "POST",
          headers,
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (err) {
        // A server that isn't running is a permanent condition for this
        // process (same class as "CLI not installed"): let provider.ts fall
        // back to template letters instead of erroring once per job forever.
        if (isConnectionRefused(err)) {
          throw new ProviderUnavailableError(
            provider,
            `Could not reach ${url} (is the server running?)`,
            { cause: err },
          );
        }
        throw err;
      }

      const raw = await response.text();

      if (!response.ok) {
        throw new Error(`${provider} returned HTTP ${response.status}: ${raw.slice(0, 500)}`);
      }

      let parsed: ChatCompletion;
      try {
        parsed = JSON.parse(raw) as ChatCompletion;
      } catch (err) {
        throw new Error(`${provider} returned non-JSON output: ${raw.slice(0, 500)}`, { cause: err });
      }

      if (parsed.error) {
        const message = typeof parsed.error === "string" ? parsed.error : (parsed.error.message ?? "unknown error");
        throw new Error(`${provider} reported an error: ${message}`);
      }

      const content = parsed.choices?.[0]?.message?.content;
      if (typeof content !== "string" || content.trim().length === 0) {
        throw new Error(`${provider} returned no message content: ${raw.slice(0, 500)}`);
      }

      return stripCodeFence(content);
    },
  };
}
