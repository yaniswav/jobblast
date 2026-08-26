// Provider-agnostic AI layer, resolved per account.
//
// Everything in the app that needs a model goes through one of the two
// factories below instead of talking to a specific CLI or SDK:
//
//   getTextProvider(userId)  -> plain text in, text out (lib/ai/tailor.ts)
//   getAgentProvider(userId) -> a tool-using agent (lib/sources/aiscout.ts,
//                               lib/sources/notion-inbox.ts)
//
// Which implementation you get comes from `ai.provider`: in `selfhosted` from
// jobblast.config.json (default "claude-cli", so an existing install with no
// `ai` section behaves exactly as it did before this layer existed), in
// `saas` from that account's `user_settings.config`, with the key coming from
// that account's own encrypted credential row.
//
// Both factories can return null, and every caller must handle that:
//   - `ai.provider: "none"` -> no AI at all, by choice.
//   - the provider can't run agents (an API endpoint has no web search or
//     MCP connectors) -> getAgentProvider() is null while text still works.
//   - the provider turned out to be unreachable for this account (CLI not
//     installed, API key unset or rejected, local server down) -> the first
//     call throws ProviderUnavailableError, we log once and switch THAT
//     ACCOUNT to no-AI mode rather than retrying every 30 minutes forever.
//
// That last word is the whole point of this file's shape. It used to hold
// `built` / `disabledReason` / `startupLogged` at module scope, which in a
// multi-tenant process means one user's bad key silently disables AI for
// everybody (docs/SAAS-ARCHITECTURE.md section 5, "failure isolation", and
// step D2, "the third riskiest step"). Those variables are gone, not
// shadowed: both caches are bounded per-account maps, and `disableAi()` is
// now `disableAiForUser()`. In `selfhosted` there is exactly one account, so
// behavior is identical to before.

import { IS_SAAS } from "../mode";
import { BoundedCache } from "../lru";
import { configFor, loadConfig, type AiProviderName, type ByokProviderName } from "../config";
import { logger } from "../logger";
import { recordCredentialTestResult } from "../repo/ai-credentials";
import {
  byokApiKeyResolver,
  envApiKeyResolver,
  noApiKeyResolver,
  type ApiKeyResolver,
} from "./api-key";
import { ProviderUnavailableError } from "./errors";
import { createAnthropicApiProvider } from "./providers/anthropic-api";
import { createClaudeCliProvider } from "./providers/claude-cli";
import { createCodexCliProvider } from "./providers/codex-cli";
import { createGeminiCliProvider } from "./providers/gemini-cli";
import {
  createOpenAiCompatibleProvider,
  resolveProviderSettings,
} from "./providers/openai-compatible";

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

type Built = {
  providerName: AiProviderName;
  text: TextProvider | null;
  agent: AgentProvider | null;
};

/**
 * How many accounts' resolved providers and no-AI verdicts stay in memory.
 * Comfortably above the beta account cap (JOBBLAST_MAX_ACCOUNTS, 150 by
 * default), so in practice nothing is ever evicted, and bounded anyway so a
 * larger install degrades into extra rebuilds rather than into a leak.
 */
const CACHE_CAPACITY = 256;

/**
 * How long an account stays in no-AI mode after a permanent-looking failure.
 * In `selfhosted` it never expires, exactly as before: the failure means a
 * missing CLI or an unset variable, neither of which a running process can
 * fix, and a restart re-tries. In `saas` the user can fix their own key from
 * Settings, and saving one drops the entry immediately anyway
 * (forgetUserProvider), so this is only the backstop for a key that starts
 * working again on the provider's side.
 */
const SAAS_DISABLED_TTL_MS = 15 * 60 * 1000;

const builtByUser = new BoundedCache<string, Built>(CACHE_CAPACITY);
const disabledByUser = new BoundedCache<string, { reason: string; until: number }>(CACHE_CAPACITY);
const startupLoggedFor = new Set<string>();

/** The ambient account's configured provider, for log lines inside a pass. */
export function configuredProviderName(): AiProviderName {
  return loadConfig().ai.provider;
}

/**
 * A named account's configured provider. Everything below resolves through
 * this rather than through the ambient context: these functions are already
 * given the account they act for, and reading the context as well would make
 * a mismatch between the two possible - which is exactly the class of bug
 * this file exists to remove.
 */
function providerNameFor(userId: string): AiProviderName {
  return configFor(userId).ai.provider;
}

// ---------------------------------------------------------------------------
// Building one account's providers
// ---------------------------------------------------------------------------

/** Where an API-key provider gets its key, per mode. */
function keyResolverFor(provider: AiProviderName, userId: string): ApiKeyResolver {
  if (IS_SAAS) {
    return byokApiKeyResolver(userId, provider as ByokProviderName);
  }

  if (provider === "anthropic-api") {
    return envApiKeyResolver(
      provider,
      "ANTHROPIC_API_KEY",
      "add it to .env - it does not belong in jobblast.config.json",
    );
  }

  // openai-compatible / ollama / lmstudio: the variable to read is itself
  // configurable, and an empty one means "this endpoint needs no key".
  const { apiKeyEnv } = resolveProviderSettings(provider);
  if (apiKeyEnv.trim().length === 0) return noApiKeyResolver();
  return envApiKeyResolver(
    provider,
    apiKeyEnv.trim(),
    'add it to .env, or set ai.openaiCompatible.apiKeyEnv to "" for a local server that needs no key',
  );
}

/**
 * Records what a provider call did on the account's credential row, so
 * Settings and the outage banner can say "your key stopped working" instead
 * of the letters silently going back to being templates. saas only: there is
 * no credential row to write in selfhosted, where the key is an env var.
 */
function recordOutcome(userId: string, provider: AiProviderName, error: string | null): void {
  if (!IS_SAAS) return;
  if (provider !== "anthropic-api" && provider !== "openai-compatible") return;
  void recordCredentialTestResult(userId, provider, { ok: error === null, error }).catch(
    (err: unknown) => {
      logger.warn({ err }, "Could not record the AI call outcome on the credential row");
    },
  );
}

/** Wraps a text provider so every call's outcome lands on the credential row. */
function withOutcomeRecording(
  userId: string,
  provider: AiProviderName,
  inner: TextProvider,
): TextProvider {
  return {
    name: inner.name,
    async generateText(prompt, opts) {
      try {
        const text = await inner.generateText(prompt, opts);
        recordOutcome(userId, provider, null);
        return text;
      } catch (err) {
        recordOutcome(userId, provider, (err as Error).message.slice(0, 2000));
        throw err;
      }
    },
  };
}

function build(userId: string): Built {
  const providerName = providerNameFor(userId);

  switch (providerName) {
    case "none":
      return { providerName, text: null, agent: null };
    case "claude-cli": {
      const p = createClaudeCliProvider();
      return { providerName, text: p, agent: p };
    }
    case "codex-cli": {
      const p = createCodexCliProvider();
      return { providerName, text: p, agent: p };
    }
    case "gemini-cli": {
      const p = createGeminiCliProvider();
      return { providerName, text: p, agent: p };
    }
    case "anthropic-api": {
      // Text only: the Messages API here is a plain completion call, with no
      // MCP connectors and no web-search tool wired up.
      const p = createAnthropicApiProvider(keyResolverFor(providerName, userId));
      return { providerName, text: withOutcomeRecording(userId, providerName, p), agent: null };
    }
    case "openai-compatible":
    case "ollama":
    case "lmstudio": {
      const p = createOpenAiCompatibleProvider(providerName, keyResolverFor(providerName, userId));
      return { providerName, text: withOutcomeRecording(userId, providerName, p), agent: null };
    }
  }
}

function ensureBuilt(userId: string): Built {
  const cached = builtByUser.get(userId);
  // A provider built from an older `ai.provider` value is stale: the account
  // can change it from Settings, and forgetUserProvider() is called on that
  // path, but comparing is free and covers a write from another process.
  if (cached && cached.providerName === providerNameFor(userId)) return cached;

  const fresh = build(userId);
  builtByUser.set(userId, fresh);
  return fresh;
}

/** True while `userId` is in no-AI mode; expires the entry when its TTL is up. */
function isDisabled(userId: string): boolean {
  const entry = disabledByUser.get(userId);
  if (!entry) return false;
  if (Date.now() < entry.until) return true;
  disabledByUser.delete(userId);
  return false;
}

// ---------------------------------------------------------------------------
// The two factories
// ---------------------------------------------------------------------------

/**
 * The text provider for one account, or null when AI is off for it (by
 * config, or after a permanent-looking failure of its own).
 *
 * Async because in `saas` the account's key lives in the database. In
 * `selfhosted` nothing is awaited that touches IO: the resolved value comes
 * from the config file, same as before.
 */
export async function getTextProvider(userId: string): Promise<TextProvider | null> {
  if (isDisabled(userId)) return null;
  return ensureBuilt(userId).text;
}

/**
 * The agent provider for one account, or null when the configured provider
 * cannot run tool-using agents (or AI is off entirely for that account).
 */
export async function getAgentProvider(userId: string): Promise<AgentProvider | null> {
  if (isDisabled(userId)) return null;
  return ensureBuilt(userId).agent;
}

/**
 * Switches ONE ACCOUNT to no-AI mode: every later getTextProvider() /
 * getAgentProvider() for it returns null, so its tailoring pass falls back to
 * the template letter instead of erroring once per job, every 30 minutes.
 * Another account's provider is untouched, which is the entire reason this
 * function takes a `userId`.
 *
 * Called when a provider reports it is unreachable. Logged once per account.
 * In `saas` the reason also lands on the credential row, so the user sees it
 * in Settings and in the outage banner.
 */
export function disableAiForUser(userId: string, reason: string): void {
  if (disabledByUser.has(userId)) return;
  disabledByUser.set(userId, {
    reason,
    until: IS_SAAS ? Date.now() + SAAS_DISABLED_TTL_MS : Number.POSITIVE_INFINITY,
  });
  logger.warn(
    { provider: providerNameFor(userId), reason },
    "AI disabled for this account: letters use the template + profile-derived bullets",
  );
}

/** Why AI is off for this account right now, or null when it is not. */
export function aiDisabledReason(userId: string): string | null {
  return isDisabled(userId) ? (disabledByUser.get(userId)?.reason ?? null) : null;
}

/**
 * One line at boot saying what the AI layer will do for the self-hosted
 * account, so "why is every letter a template?" is answerable from the log
 * without reading the config.
 */
export async function logAiProviderStatus(userId: string): Promise<void> {
  if (startupLoggedFor.has(userId)) return;
  startupLoggedFor.add(userId);

  const provider = providerNameFor(userId);
  if (provider === "none") {
    logger.info('AI disabled: letters use the template + profile-derived bullets (ai.provider = "none")');
    return;
  }

  logger.info(
    { provider, agentCapable: (await getAgentProvider(userId)) !== null },
    "AI provider configured",
  );
}

/**
 * Forgets one account's resolved provider and its no-AI verdict, so the next
 * call rebuilds from whatever is saved now. Called after a settings or
 * credential write. With no argument, forgets every account (tests, and the
 * self-hosted config file changing under a single-account process).
 */
export function forgetUserProvider(userId?: string): void {
  if (userId === undefined) {
    builtByUser.clear();
    disabledByUser.clear();
    startupLoggedFor.clear();
    return;
  }
  builtByUser.delete(userId);
  disabledByUser.delete(userId);
  startupLoggedFor.delete(userId);
}

/** True when `err` means "this provider can never work for this account". */
export function isProviderUnavailable(err: unknown): err is ProviderUnavailableError {
  return err instanceof ProviderUnavailableError;
}
