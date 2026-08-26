import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadConfig, resetConfigCache } from "./config";
// The ollama/lmstudio "presets" that fill in baseUrl/model live next to the
// provider that actually uses them (providers/openai-compatible.ts), not in
// config.ts - config.ts only leaves those fields undefined when unset. Tested
// here anyway since it is the other half of the "what does an unconfigured
// ai.provider actually resolve to" behavior the config.ts bullet is about.
import { resolveProviderSettings } from "./ai/providers/openai-compatible";

// loadConfig() reads jobblast.config.json from the repo root by default, and
// this repo has a real, gitignored one full of personal data. Every test
// below points JOBBLAST_CONFIG at an isolated temp file (or a path that
// can't exist, for the "missing file" case) and resets the module cache
// first, so none of this ever touches that file.
let configDir: string;

beforeEach(() => {
  resetConfigCache();
  configDir = fs.mkdtempSync(path.join(os.tmpdir(), "jobblast-config-test-"));
});

afterEach(() => {
  resetConfigCache();
  delete process.env["JOBBLAST_CONFIG"];
  fs.rmSync(configDir, { recursive: true, force: true });
});

function useConfig(contents: string): void {
  const file = path.join(configDir, "jobblast.config.json");
  fs.writeFileSync(file, contents, "utf8");
  process.env["JOBBLAST_CONFIG"] = file;
}

describe("loadConfig", () => {
  it("falls back to defaults when the file is missing", () => {
    process.env["JOBBLAST_CONFIG"] = path.join(configDir, "nonexistent.json");
    const config = loadConfig();
    expect(config.contact.name).toBe("Your Name");
    expect(config.ai.provider).toBe("claude-cli");
    expect(config.scoring.scoreCap).toBe(98);
    expect(config.gmailSync.enabled).toBe(false);
  });

  it("accepts ai.provider 'none' and still fills in the rest of the ai defaults", () => {
    useConfig(JSON.stringify({ ai: { provider: "none" } }));
    const config = loadConfig();
    expect(config.ai.provider).toBe("none");
    expect(config.ai.model).toBe("sonnet");
    expect(config.ai.timeoutMs).toBe(180_000);
  });

  it.each([
    ["malformed JSON", "{ not valid json", "not valid JSON"],
    ["an unknown ai.provider", JSON.stringify({ ai: { provider: "bogus-provider" } }), "failed validation"],
  ])("throws for %s", (_label, contents, expectedMessage) => {
    useConfig(contents);
    expect(() => loadConfig()).toThrow(expectedMessage);
  });
});

describe("resolveProviderSettings (ollama/lmstudio presets)", () => {
  beforeEach(() => {
    // No ai.openaiCompatible overrides in this config, so every field must
    // come from the alias preset.
    process.env["JOBBLAST_CONFIG"] = path.join(configDir, "nonexistent.json");
  });

  it("fills ollama's local-server baseUrl/model/apiKeyEnv", () => {
    expect(resolveProviderSettings("ollama")).toEqual({
      baseUrl: "http://localhost:11434/v1",
      apiKeyEnv: "",
      model: "llama3.1",
      temperature: null,
    });
  });

  it("fills lmstudio's local-server baseUrl/model/apiKeyEnv", () => {
    expect(resolveProviderSettings("lmstudio")).toEqual({
      baseUrl: "http://localhost:1234/v1",
      apiKeyEnv: "",
      model: "local-model",
      temperature: null,
    });
  });

  it("lets an explicit config value override the preset, key by key", () => {
    useConfig(JSON.stringify({ ai: { provider: "ollama", openaiCompatible: { model: "qwen2.5" } } }));
    const resolved = resolveProviderSettings("ollama");
    expect(resolved.model).toBe("qwen2.5"); // overridden
    expect(resolved.baseUrl).toBe("http://localhost:11434/v1"); // still the preset
  });
});
