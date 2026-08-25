// `claude-cli` provider: the local Claude Code CLI run headless (`claude -p`).
//
// This is the default provider and the only one that supports all three agent
// tools, because the claude.ai account-level MCP connectors (Notion, Indeed,
// Snagajob, ...) are reachable from a headless `claude` session and can be
// scoped per run with --allowedTools.
//
// The actual spawning, Windows claude/claude.cmd fallback and JSON envelope
// parsing live in lib/ai/claude-cli.ts, which predates this layer; this file
// is only the mapping from the provider-agnostic vocabulary (tools, effort)
// onto that CLI's flags.

import { loadConfig } from "../../config";
import { runClaudePrompt } from "../claude-cli";
import type { AgentProvider, AgentTool } from "../provider";

/**
 * The four Gmail tools the read-only mail passes are allowed to call.
 *
 * This is the one capability that is NOT granted as a whole MCP server, and
 * the exception is deliberate. `mcp__claude_ai_Gmail` also exposes
 * send_message, reply, forward, trash_thread, update_message_labels,
 * mark_message_spam and friends; a prompt saying "read only" is a request,
 * whereas --allowedTools is enforced by the CLI - a tool outside the list
 * needs a permission decision, and a headless `claude -p` session has nobody
 * to ask, so the call is refused. lib/gmail-sync.ts reads recruiter mail to
 * move application statuses and must never write to the mailbox, so the
 * guarantee is worth the cost of naming tools that could change server-side
 * (if one is renamed the pass degrades to finding nothing, which is the safe
 * direction to fail in).
 */
const GMAIL_READ_ONLY_TOOLS = [
  "mcp__claude_ai_Gmail__search_threads",
  "mcp__claude_ai_Gmail__get_thread",
  "mcp__claude_ai_Gmail__get_message",
  "mcp__claude_ai_Gmail__list_labels",
];

/**
 * Claude Code tool patterns per capability. Allowing a whole MCP server (no
 * third `__tool` segment) means every tool it exposes is usable without
 * hardcoding names that can change server-side - see GMAIL_READ_ONLY_TOOLS
 * for the one capability where that trade-off goes the other way.
 */
function toolPatterns(tool: AgentTool): string[] {
  switch (tool) {
    case "web":
      return ["WebSearch", "WebFetch"];
    case "notion":
      return ["mcp__claude_ai_Notion"];
    case "gmail":
      return GMAIL_READ_ONLY_TOOLS;
    case "job-connectors":
      return loadConfig().sources.aiScout.allowedConnectors;
  }
}

export function createClaudeCliProvider(): AgentProvider {
  return {
    name: "claude-cli",

    async generateText(prompt, opts = {}) {
      const { model, timeoutMs } = loadConfig().ai;
      return runClaudePrompt(prompt, {
        timeoutMs: opts.timeoutMs ?? timeoutMs,
        model,
      });
    },

    supportsTool() {
      return true;
    },

    async runAgent(prompt, opts) {
      const { model, timeoutMs } = loadConfig().ai;

      const allowed = [...new Set(opts.tools.flatMap(toolPatterns))].filter((p) => p.length > 0);
      const extraArgs: string[] = [];
      if (allowed.length > 0) extraArgs.push("--allowedTools", allowed.join(","));
      if (opts.effort) extraArgs.push("--effort", opts.effort);

      return runClaudePrompt(prompt, {
        timeoutMs: opts.timeoutMs ?? timeoutMs,
        model,
        extraArgs,
      });
    },
  };
}
