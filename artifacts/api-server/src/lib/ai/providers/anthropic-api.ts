// `anthropic-api` provider: the official Anthropic Messages API through
// @anthropic-ai/sdk. Text only - this is a plain completion call with no MCP
// connectors and no server-side web-search tool, so getAgentProvider()
// returns null for it and AI Scout / Notion Inbox stay off.
//
// Unlike every other setting, the key is NOT read from jobblast.config.json:
// it comes from ANTHROPIC_API_KEY in .env, so a config file can be shared or
// pasted into an issue without leaking a credential. Only the model and
// max_tokens are configurable (`ai.anthropicApi`).
//
// This file deliberately contains no OpenAI-shaped code; providers/
// openai-compatible.ts is the mirror image and contains no Anthropic SDK.

import Anthropic from "@anthropic-ai/sdk";
import { loadConfig } from "../../config";
import { ProviderUnavailableError } from "../errors";
import type { TextProvider } from "../provider";
import { stripCodeFence } from "./shared";

const PROVIDER_NAME = "anthropic-api";
const API_KEY_ENV = "ANTHROPIC_API_KEY";

let client: Anthropic | null = null;

function getClient(): Anthropic {
  if (client) return client;

  const apiKey = process.env[API_KEY_ENV];
  if (!apiKey || apiKey.trim().length === 0) {
    throw new ProviderUnavailableError(
      PROVIDER_NAME,
      `${API_KEY_ENV} is not set (add it to .env - it does not belong in jobblast.config.json)`,
    );
  }

  client = new Anthropic({ apiKey });
  return client;
}

export function createAnthropicApiProvider(): TextProvider {
  return {
    name: PROVIDER_NAME,

    async generateText(prompt, opts = {}) {
      const { anthropicApi, timeoutMs } = loadConfig().ai;

      const response = await getClient().messages.create(
        {
          model: anthropicApi.model,
          max_tokens: opts.maxTokens ?? anthropicApi.maxTokens,
          messages: [{ role: "user", content: prompt }],
        },
        { timeout: opts.timeoutMs ?? timeoutMs },
      );

      // A safety decline arrives as a normal 200 response, not an exception:
      // check before reading content, or you silently get an empty letter.
      if (response.stop_reason === "refusal") {
        throw new Error(
          `Anthropic API declined the request (category=${response.stop_details?.category ?? "unknown"})`,
        );
      }

      const text = response.content
        .filter((block): block is Anthropic.TextBlock => block.type === "text")
        .map((block) => block.text)
        .join("");

      if (text.trim().length === 0) {
        throw new Error(`Anthropic API returned no text (stop_reason=${response.stop_reason ?? "unknown"})`);
      }

      return stripCodeFence(text);
    },
  };
}
