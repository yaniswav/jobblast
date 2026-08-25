// Provider-agnostic AI layer.
//
// Everything in the app that needs a model goes through one of the two
// factories below instead of talking to a specific CLI or SDK:
//
//   getTextProvider()  -> plain text in, text out (lib/ai/tailor.ts)
//   getAgentProvider() -> a tool-using agent (lib/sources/aiscout.ts,
//                         lib/sources/notion-inbox.ts)
//
// Which implementation you get comes from `ai.provider` in
// jobblast.config.json (default "claude-cli", so an existing install with no
// `ai` section behaves exactly as it did before this layer existed).
//
// Both factories can return null, and every caller must handle that:
//   - `ai.provider: "none"` -> no AI at all, by choice.
//   - the provider can't run agents (an API endpoint has no web search or
//     MCP connectors) -> getAgentProvider() is null while text still works.
//   - the provider turned out to be unreachable on this machine (CLI not
//     installed, API key unset, local server down) -> the first call throws
//     ProviderUnavailableError, we log once and switch the whole process to
//     no-AI mode rather than retrying every 30 minutes forever.

import { loadConfig, type AiProviderName } from "../config";
import { logger } from "../logger";
import { ProviderUnavailableError } from "./errors";
import { createAnthropicApiProvider } from "./providers/anthropic-api";
import { createClaudeCliProvider } from "./providers/claude-cli";
import { createCodexCliProvider } from "./providers/codex-cli";
import { createGeminiCliProvider } from "./providers/gemini-cli";
import { createOpenAiCompatibleProvider } from "./providers/openai-compatible";

export { ProviderUnavailableError } from "./errors";

/**
 * Capabilities an agent run may need. Each provider maps these onto whatever
 * its own CLI calls them (see the adapters under providers/).
 *
 *   web             - live web search / page fetch
 *   notion          - the user's Notion workspace, via an MCP connector
 *   job-connectors  - the job-board MCP connectors listed in
 *                     `sources.aiScout.allowedConnectors`
 *   gmail           - READ-ONLY access to the user's Gmail, via an MCP
 *                     connector. Unlike the others this one carries a
 *                     capability promise, not just "can you reach it": a
 *                     provider may only report it supported if it can hand
 *                     the agent search/read tools *without* also handing it
 *                     send/reply/label/trash. Used by lib/gmail-sync.ts,
 *                     which updates application statuses from recruiter
 *                     mail and must never touch the mailbox itself.
 */
export type AgentTool = "web" | "notion" | "job-connectors" | "gmail";

export type AgentEffort = "low" | "medium" | "high";

export type TextProvider = {
  /** Stable identifier, matching the `ai.provider` config value. */
  name: string;
  generateText(prompt: string, opts?: { timeoutMs?: number; maxTokens?: number }): Promise<string>;
};

export type AgentProvider = TextProvider & {
  /**
   * Whether this provider can actually give the agent `tool` on this machine.
   * Callers check the tools they depend on before running: Notion Inbox needs
   * "notion", AI Scout needs "web".
   */
  supportsTool(tool: AgentTool): boolean;
  runAgent(
    prompt: string,
    opts: { timeoutMs?: number; tools: AgentTool[]; effort?: AgentEffort },
  ): Promise<string>;
};

type Built = { text: TextProvider | null; agent: AgentProvider | null };

let built: Built | null = null;
let disabledReason: string | null = null;
let startupLogged = false;

/** The configured provider name, usable in log lines even when it failed to load. */
export function configuredProviderName(): AiProviderName {
  return loadConfig().ai.provider;
}

function build(): Built {
  const provider = configuredProviderName();

  switch (provider) {
    case "none":
      return { text: null, agent: null };
    case "claude-cli": {
      const p = createClaudeCliProvider();
      return { text: p, agent: p };
    }
    case "codex-cli": {
      const p = createCodexCliProvider();
      return { text: p, agent: p };
    }
    case "gemini-cli": {
      const p = createGeminiCliProvider();
      return { text: p, agent: p };
    }
    case "anthropic-api":
      // Text only: the Messages API here is a plain completion call, with no
      // MCP connectors and no web-search tool wired up.
      return { text: createAnthropicApiProvider(), agent: null };
    case "openai-compatible":
    case "ollama":
    case "lmstudio":
      return { text: createOpenAiCompatibleProvider(provider), agent: null };
  }
}

function ensureBuilt(): Built {
  built ??= build();
  return built;
}

/** The text provider, or null when AI is off (by config or after a failure). */
export function getTextProvider(): TextProvider | null {
  if (disabledReason) return null;
  return ensureBuilt().text;
}

/**
 * The agent provider, or null when the configured provider cannot run
 * tool-using agents (or AI is off entirely).
 */
export function getAgentProvider(): AgentProvider | null {
  if (disabledReason) return null;
  return ensureBuilt().agent;
}

/**
 * Switches the process to no-AI mode: every later getTextProvider() /
 * getAgentProvider() returns null, so the tailoring pass falls back to the
 * template letter instead of erroring once per job, every 30 minutes.
 *
 * Called when a provider reports it is unreachable on this machine. Logged
 * once; restarting the server re-tries the provider.
 */
export function disableAi(reason: string): void {
  if (disabledReason) return;
  disabledReason = reason;
  logger.warn(
    { provider: configuredProviderName(), reason },
    "AI disabled for this process: letters use the template + profile-derived bullets (restart after fixing to re-enable)",
  );
}

export function isAiDisabled(): boolean {
  return disabledReason !== null;
}

/**
 * One line at boot saying what the AI layer will do, so "why is every letter
 * a template?" is answerable from the log without reading the config.
 */
export function logAiProviderStatus(): void {
  if (startupLogged) return;
  startupLogged = true;

  const provider = configuredProviderName();
  if (provider === "none") {
    logger.info('AI disabled: letters use the template + profile-derived bullets (ai.provider = "none")');
    return;
  }

  logger.info(
    { provider, agentCapable: getAgentProvider() !== null },
    "AI provider configured",
  );
}

/** Test/CLI hook: forget the built providers and any no-AI state. */
export function resetProviderCache(): void {
  built = null;
  disabledReason = null;
  startupLogged = false;
}

/** True when `err` means "this provider can never work in this process". */
export function isProviderUnavailable(err: unknown): err is ProviderUnavailableError {
  return err instanceof ProviderUnavailableError;
}
