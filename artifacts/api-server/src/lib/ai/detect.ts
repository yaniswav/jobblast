// Machine-local availability checks for the Settings wizard
// (GET /settings/ai/options - see lib/ai/provider-options.ts).
//
// These are deliberately separate from the provider adapters under
// providers/: a provider adapter's job is to run a real generation, while
// this module's job is a *cheap, side-effect-free* "is this even reachable"
// probe, cached for a short time so a wizard render doesn't re-spawn a CLI
// or re-hit a local server on every keystroke.

import { spawn } from "node:child_process";

type CacheEntry = { value: boolean; expiresAt: number };
const cache = new Map<string, CacheEntry>();

async function cached(key: string, ttlMs: number, check: () => Promise<boolean>): Promise<boolean> {
  const hit = cache.get(key);
  if (hit && hit.expiresAt > Date.now()) return hit.value;
  const value = await check();
  cache.set(key, { value, expiresAt: Date.now() + ttlMs });
  return value;
}

/**
 * True if `command --version` can be spawned at all (exit code doesn't
 * matter - a nonzero exit still proves the binary exists). Tries the plain
 * name first, then `<command>.cmd`, the same Windows fallback the CLI
 * providers use (see providers/shared.ts) for a binary installed via
 * `npm install -g`.
 */
function probeBinary(command: string, timeoutMs: number): Promise<boolean> {
  const candidates = [
    { cmd: command, shell: false },
    { cmd: `${command}.cmd`, shell: true },
  ];

  const tryOne = (index: number): Promise<boolean> => {
    if (index >= candidates.length) return Promise.resolve(false);
    const { cmd, shell } = candidates[index]!;

    return new Promise<boolean>((resolve) => {
      let settled = false;
      let child;
      try {
        child = spawn(cmd, ["--version"], { stdio: "ignore", shell });
      } catch {
        resolve(tryOne(index + 1));
        return;
      }

      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        child.kill("SIGKILL");
        // Didn't error out within the timeout, so the OS did find and start
        // it - treat a hang as "exists but slow" rather than "missing".
        resolve(true);
      }, timeoutMs);

      child.on("error", (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        const code = (err as NodeJS.ErrnoException).code;
        if (code === "ENOENT" || code === "EINVAL") {
          resolve(tryOne(index + 1));
        } else {
          resolve(true); // spawned, then failed some other way - it exists
        }
      });

      child.on("exit", () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(true);
      });
    });
  };

  return tryOne(0);
}

const BINARY_TTL_MS = 60_000;
const HTTP_TTL_MS = 60_000;

/** Is `command` (a CLI like `claude`, `codex`, `gemini`) on PATH? Cached 60s. */
export function isBinaryAvailable(command: string): Promise<boolean> {
  return cached(`bin:${command}`, BINARY_TTL_MS, () => probeBinary(command, 5_000));
}

/** Is something listening at `url` and answering with a 2xx? Cached 60s. */
export function isHttpServerUp(url: string, timeoutMs: number): Promise<boolean> {
  return cached(`http:${url}`, HTTP_TTL_MS, async () => {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
      return res.ok;
    } catch {
      return false;
    }
  });
}

/** Test/CLI hook: forget every cached probe result. */
export function resetDetectionCache(): void {
  cache.clear();
}
