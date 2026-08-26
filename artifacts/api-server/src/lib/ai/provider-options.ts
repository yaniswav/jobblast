// Builds the capability-driven provider list for the Settings wizard
// (GET /settings/ai/options). The frontend renders whatever comes back here
// - it never hardcodes which providers exist - so this is the one place
// that enumerates `AI_PROVIDERS` and decides, for *this machine, right now*,
// whether each one can actually run.
//
// "Can it run an agent (AI Scout, Notion Inbox)" is derived from the real
// provider adapters' own `supportsTool()` rather than a second, hand-kept
// capability table, so this list can never drift from what provider.ts
// itself would do at runtime.

import { AI_PROVIDERS, loadConfig, type AiProviderName } from "../config";
import { createClaudeCliProvider } from "./providers/claude-cli";
import { createCodexCliProvider } from "./providers/codex-cli";
import { createGeminiCliProvider } from "./providers/gemini-cli";
import { isBinaryAvailable, isHttpServerUp } from "./detect";
import type { AgentProvider } from "./provider";

export type AiProviderOption = {
  id: AiProviderName;
  available: boolean;
  detail: string;
  capabilities: { letters: boolean; scout: boolean; notionInbox: boolean };
  requiresEnv: string | null;
  envSet: boolean;
};

/**
 * The three CLI-backed providers are the only ones that can run an agent at
 * all (anthropic-api / openai-compatible / ollama / lmstudio are text-only,
 * see provider.ts's `build()`). Capabilities below are read straight off
 * these adapters' `supportsTool()`, never hand-guessed.
 */
function agentAdapterFor(id: AiProviderName): AgentProvider | null {
  switch (id) {
    case "claude-cli":
      return createClaudeCliProvider();
    case "codex-cli":
      return createCodexCliProvider();
    case "gemini-cli":
      return createGeminiCliProvider();
    default:
      return null;
  }
}

function capabilitiesFor(id: AiProviderName): AiProviderOption["capabilities"] {
  if (id === "none") return { letters: false, scout: false, notionInbox: false };
  const agent = agentAdapterFor(id);
  return {
    letters: true,
    scout: agent?.supportsTool("web") ?? false,
    notionInbox: agent?.supportsTool("notion") ?? false,
  };
}

async function describeNone(): Promise<AiProviderOption> {
  return {
    id: "none",
    available: true,
    detail: "No AI. Cover letters use your template plus profile-derived bullets.",
    capabilities: capabilitiesFor("none"),
    requiresEnv: null,
    envSet: true,
  };
}

async function describeCli(
  id: "claude-cli" | "codex-cli" | "gemini-cli",
  command: string,
  label: string,
): Promise<AiProviderOption> {
  const available = await isBinaryAvailable(command);
  return {
    id,
    available,
    detail: available
      ? `${label} CLI found on PATH.`
      : `${label} CLI not found on PATH. Install it and make sure \`${command}\` is on PATH for the account running the server.`,
    capabilities: capabilitiesFor(id),
    requiresEnv: null,
    envSet: true,
  };
}

async function describeAnthropicApi(): Promise<AiProviderOption> {
  const envVar = "ANTHROPIC_API_KEY";
  const envSet = Boolean(process.env[envVar]?.trim());
  return {
    id: "anthropic-api",
    available: envSet,
    detail: envSet ? `${envVar} is set.` : `${envVar} is not set in .env.`,
    capabilities: capabilitiesFor("anthropic-api"),
    requiresEnv: envVar,
    envSet,
  };
}

async function describeOpenAiCompatible(): Promise<AiProviderOption> {
  const configured = loadConfig().ai.openaiCompatible.apiKeyEnv;
  const envVar = (configured ?? "OPENAI_API_KEY").trim();
  if (envVar.length === 0) {
    // Explicitly configured for a keyless endpoint (e.g. a local server
    // reachable without auth) - nothing to check.
    return {
      id: "openai-compatible",
      available: true,
      detail: "Configured for a keyless endpoint (ai.openaiCompatible.apiKeyEnv is empty).",
      capabilities: capabilitiesFor("openai-compatible"),
      requiresEnv: null,
      envSet: true,
    };
  }
  const envSet = Boolean(process.env[envVar]?.trim());
  return {
    id: "openai-compatible",
    available: envSet,
    detail: envSet ? `${envVar} is set.` : `${envVar} is not set in .env.`,
    capabilities: capabilitiesFor("openai-compatible"),
    requiresEnv: envVar,
    envSet,
  };
}

async function describeLocalServer(
  id: "ollama" | "lmstudio",
  url: string,
  label: string,
): Promise<AiProviderOption> {
  const available = await isHttpServerUp(url, 2_000);
  return {
    id,
    available,
    detail: available ? `${label} responding at ${url}.` : `${label} not reachable at ${url}. Is it running?`,
    capabilities: capabilitiesFor(id),
    requiresEnv: null,
    envSet: true,
  };
}

async function describeProvider(id: AiProviderName): Promise<AiProviderOption> {
  switch (id) {
    case "none":
      return describeNone();
    case "claude-cli":
      return describeCli(id, "claude", "Claude Code");
    case "codex-cli":
      return describeCli(id, "codex", "Codex");
    case "gemini-cli":
      return describeCli(id, "gemini", "Gemini");
    case "anthropic-api":
      return describeAnthropicApi();
    case "openai-compatible":
      return describeOpenAiCompatible();
    case "ollama":
      return describeLocalServer(id, "http://localhost:11434/api/tags", "Ollama");
    case "lmstudio":
      return describeLocalServer(id, "http://localhost:1234/v1/models", "LM Studio");
  }
}

/** One descriptor per entry in `AI_PROVIDERS`, detected fresh (subject to the 60s probe cache). */
export async function listAiProviderOptions(): Promise<AiProviderOption[]> {
  return Promise.all(AI_PROVIDERS.map(describeProvider));
}
