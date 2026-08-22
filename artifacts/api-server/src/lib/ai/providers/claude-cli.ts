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
 * Claude Code tool patterns per capability. Allowing a whole MCP server (no
 * third `__tool` segment) means every tool it exposes is usable without
 * hardcoding names that can change server-side.
 */
function toolPatterns(tool: AgentTool): string[] {
  switch (tool) {
    case "web":
      return ["WebSearch", "WebFetch"];
    case "notion":
      return ["mcp__claude_ai_Notion"];
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
