// `codex-cli` provider: the OpenAI Codex CLI in non-interactive mode.
//
// Flags verified against a local `codex --help` / `codex exec --help` on
// codex-cli 0.145.0 (2026-08-22), cross-checked with the official docs at
// github.com/openai/codex and developers.openai.com/codex:
//
//   codex exec -               prompt is read from stdin when the positional
//                              argument is `-` (avoids Windows argv limits and
//                              quoting problems on long prompts)
//   -o, --output-last-message  writes the agent's final message to a file;
//                              this is the reliable way to get just the answer,
//                              since stdout also carries a session header
//   -m, --model                model override (omitted when ai.codexCli.model
//                              is empty, so Codex uses its own default)
//   -s, --sandbox read-only    Codex refuses to touch the filesystem; we only
//                              ever want text back
//   --skip-git-repo-check      allow running outside a git repo
//   --color never              no ANSI escapes in the captured output
//   -c key=value               TOML config override. Two are used:
//                                tools.web_search=true      -> live web search
//                                model_reasoning_effort=".." -> effort level
//                              (`--search` and `--effort` exist on the *top
//                              level* `codex` command but NOT on `codex exec`
//                              in 0.145.0, verified locally; `-c` works on
//                              both. `tools.web_search` was verified to be a
//                              recognized field via `--strict-config`.)
//
// MCP connectors (Notion, job boards) are configured per user in
// ~/.codex/config.toml under [mcp_servers.<name>]; Codex has no per-run tool
// allowlist flag, so whatever the user configured there is what the agent can
// reach. That means "notion" / "job-connectors" support here is best-effort:
// the flag mapping is a no-op and the prompt does the asking.

import { loadConfig } from "../../config";
import { logger } from "../../logger";
import type { AgentProvider, AgentTool } from "../provider";
import { readIfPresent, runCli, stripCodeFence, withTempFile } from "./shared";

const BASE_ARGS = ["exec", "-", "--sandbox", "read-only", "--skip-git-repo-check", "--color", "never"];

function buildArgs(params: {
  outputFile: string;
  tools: AgentTool[];
  effort?: string;
}): string[] {
  const { codexCli } = loadConfig().ai;
  const args = [...BASE_ARGS, "-o", params.outputFile];

  if (codexCli.model.trim()) args.push("-m", codexCli.model.trim());
  if (params.effort) args.push("-c", `model_reasoning_effort="${params.effort}"`);
  if (params.tools.includes("web")) args.push("-c", "tools.web_search=true");
  args.push(...codexCli.extraArgs);

  return args;
}

async function run(prompt: string, timeoutMs: number, tools: AgentTool[], effort?: string): Promise<string> {
  return withTempFile("jobblast-codex", async (outputFile) => {
    const { stdout } = await runCli({
      providerName: "codex-cli",
      command: "codex",
      args: buildArgs({ outputFile, tools, effort }),
      stdin: prompt,
      timeoutMs,
    });

    // Preferred: the file `-o` wrote. Falling back to stdout is lossy (it also
    // contains the session header Codex prints), but better than nothing if a
    // future version changes where the final message lands.
    const fromFile = readIfPresent(outputFile);
    if (fromFile) return stripCodeFence(fromFile);

    logger.warn("Codex CLI wrote no --output-last-message file, falling back to stdout");
    return stripCodeFence(stdout);
  });
}

export function createCodexCliProvider(): AgentProvider {
  return {
    name: "codex-cli",

    async generateText(prompt, opts = {}) {
      return run(prompt, opts.timeoutMs ?? loadConfig().ai.timeoutMs, []);
    },

    supportsTool(tool) {
      // "gmail" is refused outright. It is the only capability that promises
      // read-only access to something destructible, and Codex has no per-run
      // tool allowlist: if the user has a Gmail MCP server in their
      // config.toml, the agent can reach send_message and trash_thread just
      // as easily as search_threads, and the only thing standing between a
      // recruiter e-mail and a sent reply would be the prompt. Declining
      // means lib/gmail-sync.ts logs one line and does nothing on this
      // provider, which is the right failure.
      if (tool === "gmail") return false;

      // web via -c tools.web_search=true; notion / job-connectors depend on
      // the user's own ~/.codex/config.toml MCP servers (see the header).
      return true;
    },

    async runAgent(prompt, opts) {
      return run(prompt, opts.timeoutMs ?? loadConfig().ai.timeoutMs, opts.tools, opts.effort);
    },
  };
}
