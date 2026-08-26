// `gemini-cli` provider: the Google Gemini CLI in non-interactive (headless)
// mode.
//
// Flags verified against a local `gemini --help` on gemini-cli 0.56.0
// (2026-08-22), cross-checked with docs/cli/headless.md and
// docs/cli/cli-reference.md in github.com/google-gemini/gemini-cli:
//
//   -p, --prompt <text>     runs headless with that prompt. The help text says
//                           it is "Appended to input on stdin (if any)", which
//                           is what lets us put a long prompt on stdin instead
//                           of argv (see the length note below).
//   -o, --output-format json  emits one JSON object: { response, stats,
//                           error? }. `response` holds the model's answer.
//   -m, --model <id>        model override (omitted when ai.geminiCli.model is
//                           empty, so Gemini uses its own default).
//   --approval-mode <mode>  default | auto_edit | yolo | plan. In headless
//                           mode a tool call that would normally prompt is
//                           treated as *denied*, so an agent run that needs
//                           the built-in google_web_search has to raise this
//                           to "yolo". Plain text generation calls no tools
//                           and stays on "default".
//
// Agent support is web-search only. Gemini's built-in google_web_search /
// web_fetch tools need no flag to exist, but its MCP servers are declared in
// the user's own ~/.gemini/settings.json under `mcpServers` with names we
// cannot guess, so "notion", "job-connectors" and "gmail" are reported
// unsupported and Notion Inbox / AI Scout's connector pass / Gmail sync will
// not run on this provider. For "gmail" that is doubly true: agent runs here
// use --approval-mode yolo, which auto-approves every tool the model decides
// to call, and Gmail sync's whole premise is that the mailbox is read and
// never written.
//
// Security note worth knowing before enabling AI Scout here: --approval-mode
// yolo auto-approves every tool the agent decides to call, and the prompt
// contains job descriptions fetched from the open web. claude-cli's
// --allowedTools (a real per-run allowlist) is the safer option for agent
// work. Gemini's own --allowed-tools flag is marked DEPRECATED in 0.56.0, so
// it is not used here; add it through `ai.geminiCli.extraArgs` if you want it.

import { loadConfig } from "../../config";
import type { AgentProvider } from "../provider";
import { CliRunError, runCli, stripCodeFence } from "./shared";

/**
 * Above this many characters the prompt goes on stdin instead of argv.
 * Windows caps a whole command line at ~32 767 characters, and a master
 * resume plus a 4 000-character job description can get close.
 */
const ARGV_PROMPT_LIMIT = 20_000;

/** Sent as `-p` when the real prompt had to go on stdin (`-p` is what forces headless mode). */
const STDIN_CONTINUATION = "Follow the instructions above exactly and output only what they ask for.";

type GeminiJson = {
  response?: string;
  error?: { message?: string; type?: string } | string;
};

function buildArgs(prompt: string, agentMode: boolean) {
  const { geminiCli } = loadConfig().ai;

  const args = ["--output-format", "json", "--approval-mode", agentMode ? "yolo" : "default"];
  if (geminiCli.model.trim()) args.push("-m", geminiCli.model.trim());

  let stdin = "";
  if (prompt.length <= ARGV_PROMPT_LIMIT) {
    args.push("-p", prompt);
  } else {
    stdin = `${prompt}\n`;
    args.push("-p", STDIN_CONTINUATION);
  }

  args.push(...geminiCli.extraArgs);
  return { args, stdin };
}

function parseResponse(stdout: string): string {
  const trimmed = stdout.trim();

  let parsed: GeminiJson;
  try {
    parsed = JSON.parse(trimmed) as GeminiJson;
  } catch {
    // --output-format json is documented, but if a future version prints
    // plain text anyway, the raw output is still usable.
    return stripCodeFence(trimmed);
  }

  if (parsed.error) {
    const message = typeof parsed.error === "string" ? parsed.error : (parsed.error.message ?? "unknown error");
    throw new CliRunError(`Gemini CLI reported an error: ${message}`);
  }

  if (typeof parsed.response !== "string") {
    throw new CliRunError(`Gemini CLI returned JSON without a "response" string: ${trimmed.slice(0, 500)}`);
  }

  return stripCodeFence(parsed.response);
}

async function run(prompt: string, timeoutMs: number, agentMode: boolean): Promise<string> {
  const { args, stdin } = buildArgs(prompt, agentMode);
  const { stdout } = await runCli({
    providerName: "gemini-cli",
    command: "gemini",
    args,
    stdin,
    timeoutMs,
  });
  return parseResponse(stdout);
}

export function createGeminiCliProvider(): AgentProvider {
  return {
    name: "gemini-cli",

    async generateText(prompt, opts = {}) {
      return run(prompt, opts.timeoutMs ?? loadConfig().ai.timeoutMs, false);
    },

    supportsTool(tool) {
      return tool === "web";
    },

    async runAgent(prompt, opts) {
      return run(prompt, opts.timeoutMs ?? loadConfig().ai.timeoutMs, true);
    },
  };
}
