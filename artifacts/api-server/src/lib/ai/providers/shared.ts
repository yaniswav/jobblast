// Helpers shared by the CLI-backed provider adapters (codex-cli, gemini-cli).
//
// The `claude` adapter keeps using lib/ai/claude-cli.ts, which predates this
// layer and carries its own (identical in spirit) spawn logic plus the
// Claude-specific JSON envelope parsing.

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { logger } from "../../logger";
import { ProviderUnavailableError } from "../errors";

/** Strips a leading/trailing ```json ... ``` (or plain ```) fence if present. */
export function stripCodeFence(text: string): string {
  const trimmed = text.trim();
  const match = /^```(?:json)?\s*([\s\S]*?)\s*```$/.exec(trimmed);
  return match ? match[1]!.trim() : trimmed;
}

type Invocation = { command: string; shell: boolean };

// Windows note (same problem lib/ai/claude-cli.ts documents): a CLI installed
// via npm -g is a POSIX shell script with no extension that Node's spawn
// cannot execute directly; the real Windows entry point is `<name>.cmd`, which
// in turn needs `shell: true` (spawning a .cmd with shell:false throws a
// synchronous EINVAL rather than emitting an async 'error' event). We probe
// the plain name first, fall back to `<name>.cmd` with a shell, and remember
// whichever worked so we don't re-probe on every call.
const cachedInvocations = new Map<string, Invocation>();

function isEnoentOrInvalid(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  return code === "ENOENT" || code === "EINVAL";
}

export class CliRunError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "CliRunError";
  }
}

type SpawnResult = { stdout: string; stderr: string };

function spawnOnce(
  invocation: Invocation,
  args: string[],
  stdin: string,
  timeoutMs: number,
  label: string,
): Promise<SpawnResult> {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(invocation.command, args, {
        stdio: ["pipe", "pipe", "pipe"],
        shell: invocation.shell,
      });
    } catch (err) {
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
      reject(new CliRunError(`${label} timed out after ${timeoutMs}ms`));
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
          new CliRunError(
            `${label} exited with code ${code}: ${stderr.slice(0, 2000) || "(no stderr)"}`,
          ),
        );
        return;
      }
      resolve({ stdout, stderr });
    });

    child.stdin?.write(stdin);
    child.stdin?.end();
  });
}

/**
 * Runs `command args...` with `stdin` piped in, returning its stdout/stderr.
 *
 * Throws `ProviderUnavailableError` when the binary cannot be found at all
 * (so the caller can switch the process to no-AI mode), and `CliRunError` for
 * a real failure of an installed CLI (non-zero exit, timeout).
 */
export async function runCli(params: {
  providerName: string;
  command: string;
  args: string[];
  stdin: string;
  timeoutMs: number;
}): Promise<SpawnResult> {
  const { providerName, command, args, stdin, timeoutMs } = params;
  const label = `${command} CLI`;

  const cached = cachedInvocations.get(command);
  if (cached) {
    return spawnOnce(cached, args, stdin, timeoutMs, label);
  }

  const candidates: Invocation[] = [
    { command, shell: false },
    { command: `${command}.cmd`, shell: true },
  ];

  let lastError: unknown;
  for (const candidate of candidates) {
    try {
      const result = await spawnOnce(candidate, args, stdin, timeoutMs, label);
      cachedInvocations.set(command, candidate);
      return result;
    } catch (err) {
      lastError = err;
      if (!isEnoentOrInvalid(err)) {
        // A real failure of an installed CLI - a different invocation shape
        // would fail the same way.
        cachedInvocations.set(command, candidate);
        throw err;
      }
      logger.debug({ command: candidate.command, err }, `${label} invocation shape failed, trying next`);
    }
  }

  throw new ProviderUnavailableError(
    providerName,
    `Could not find a working \`${command}\` CLI invocation (is it installed and on PATH?)`,
    { cause: lastError },
  );
}

/**
 * Creates a unique temp file path, runs `fn` with it, and removes the file
 * afterwards. Used for CLIs that write their final answer to a file
 * (`codex exec -o <file>`) rather than only to stdout.
 */
export async function withTempFile<T>(prefix: string, fn: (filePath: string) => Promise<T>): Promise<T> {
  const filePath = path.join(
    os.tmpdir(),
    `${prefix}-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.txt`,
  );
  try {
    return await fn(filePath);
  } finally {
    try {
      fs.rmSync(filePath, { force: true });
    } catch {
      // Best effort: a leftover temp file is not worth failing a run over.
    }
  }
}

/** Reads `filePath` as UTF-8, returning null if it doesn't exist or is empty. */
export function readIfPresent(filePath: string): string | null {
  try {
    const text = fs.readFileSync(filePath, "utf8").trim();
    return text.length > 0 ? text : null;
  } catch {
    return null;
  }
}
