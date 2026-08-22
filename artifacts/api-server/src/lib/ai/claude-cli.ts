// Thin wrapper around the local `claude` CLI (Claude Code), run headless via
// `claude -p`. This lets tailoring calls ride the user's Claude subscription
// instead of a metered API key — see lib/ai/tailor.ts for the caller.
//
// The prompt is always passed via stdin, never argv, to avoid Windows
// quoting/escaping issues (and to dodge argv length limits on long prompts).
//
// Windows note: `claude` on PATH is usually a POSIX shell script with no
// extension (from the npm global install), which Node's spawn cannot
// execute directly without a shell. The actual Windows entry point is
// `claude.cmd`, which itself cannot be spawned without `shell: true`
// (spawning a .cmd file with shell:false throws a synchronous EINVAL, not
// an async 'error' event). We try the plain `claude` executable first (this
// works as-is in POSIX environments and in some Windows shells), and fall
// back to `claude.cmd` with `shell: true` on failure. Once one of the two
// works, we remember it for subsequent calls instead of re-probing.

import { spawn } from "node:child_process";
import { logger } from "../logger";

const DEFAULT_TIMEOUT_MS = 180_000;
const BASE_CLI_ARGS = ["-p", "--output-format", "json", "--model", "sonnet"];

export type RunClaudePromptOptions = {
  /** Overrides the default 180s timeout. */
  timeoutMs?: number;
  /** Extra CLI args appended after the base args (e.g. ["--allowedTools", "WebSearch,WebFetch"] to enable web tools). */
  extraArgs?: string[];
};

/** Shape of the `claude -p --output-format json` envelope we rely on. */
type ClaudeCliEnvelope = {
  is_error: boolean;
  subtype?: string;
  result?: string;
  error?: string;
};

export class ClaudeCliError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "ClaudeCliError";
  }
}

type Invocation = { command: string; shell: boolean };

// Cache the invocation shape (plain executable vs .cmd-via-shell) once we
// know which one works on this machine, so we don't re-probe on every call.
let cachedInvocation: Invocation | null = null;

function isEnoentOrInvalid(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  return code === "ENOENT" || code === "EINVAL";
}

/** Spawns one CLI process, feeds `prompt` on stdin, and resolves with stdout. */
function spawnClaude(
  invocation: Invocation,
  prompt: string,
  args: string[],
  timeoutMs: number,
): Promise<string> {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(invocation.command, args, {
        stdio: ["pipe", "pipe", "pipe"],
        shell: invocation.shell,
      });
    } catch (err) {
      // Spawning a .cmd file with shell:false throws synchronously (EINVAL)
      // rather than emitting an async 'error' event, so this catch matters.
      reject(err);
      return;
    }

    let stdout = "";
    let stderr = "";
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGKILL");
      reject(new ClaudeCliError(`Claude CLI timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });

    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    });

    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code !== 0) {
        reject(
          new ClaudeCliError(
            `Claude CLI exited with code ${code}: ${stderr.slice(0, 2000) || "(no stderr)"}`,
          ),
        );
        return;
      }
      resolve(stdout);
    });

    child.stdin?.write(prompt);
    child.stdin?.end();
  });
}

/** Runs the CLI, trying the cached invocation first, then probing both known shapes. */
async function runClaudeCli(prompt: string, args: string[], timeoutMs: number): Promise<string> {
  if (cachedInvocation) {
    return spawnClaude(cachedInvocation, prompt, args, timeoutMs);
  }

  const candidates: Invocation[] = [
    { command: "claude", shell: false },
    { command: "claude.cmd", shell: true },
  ];

  let lastError: unknown;
  for (const candidate of candidates) {
    try {
      const stdout = await spawnClaude(candidate, prompt, args, timeoutMs);
      cachedInvocation = candidate;
      return stdout;
    } catch (err) {
      lastError = err;
      if (!isEnoentOrInvalid(err)) {
        // A real failure (non-zero exit, timeout, etc.) - not worth
        // retrying with a different invocation shape.
        throw err;
      }
      logger.debug(
        { command: candidate.command, err },
        "Claude CLI invocation shape failed, trying next candidate",
      );
    }
  }

  throw new ClaudeCliError("Could not find a working `claude` CLI invocation", {
    cause: lastError,
  });
}

/** Strips a leading/trailing ```json ... ``` (or plain ```) fence if present. */
function stripCodeFence(text: string): string {
  const trimmed = text.trim();
  const match = /^```(?:json)?\s*([\s\S]*?)\s*```$/.exec(trimmed);
  return match ? match[1]!.trim() : trimmed;
}

/**
 * Runs `claude -p` headlessly with `prompt` on stdin and returns the model's
 * raw text response (the envelope's `result` field, with markdown code
 * fences stripped if the model wrapped its answer in one).
 *
 * `options.timeoutMs` overrides the default 180s timeout (e.g. for a
 * longer-running web-search-backed prompt). `options.extraArgs` are appended
 * after the base `-p --output-format json --model sonnet` args (e.g.
 * `["--allowedTools", "WebSearch,WebFetch"]` to enable web tools headlessly).
 *
 * Throws `ClaudeCliError` on spawn failure, non-zero exit, timeout, a
 * malformed envelope, or an envelope reporting `is_error: true`.
 */
export async function runClaudePrompt(
  prompt: string,
  options: RunClaudePromptOptions = {},
): Promise<string> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const args = options.extraArgs ? [...BASE_CLI_ARGS, ...options.extraArgs] : BASE_CLI_ARGS;
  const stdout = await runClaudeCli(prompt, args, timeoutMs);

  let envelope: ClaudeCliEnvelope;
  try {
    envelope = JSON.parse(stdout) as ClaudeCliEnvelope;
  } catch (err) {
    throw new ClaudeCliError(
      `Claude CLI returned non-JSON output: ${stdout.slice(0, 500)}`,
      { cause: err },
    );
  }

  if (envelope.is_error || typeof envelope.result !== "string") {
    throw new ClaudeCliError(
      `Claude CLI reported an error (subtype=${envelope.subtype ?? "unknown"}): ${
        envelope.error ?? envelope.result ?? "no result field"
      }`,
    );
  }

  return stripCodeFence(envelope.result);
}
