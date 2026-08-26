import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { letterLanguageRule } from "./language";
import { resetConfigCache } from "../config";

let configDir: string;

beforeEach(() => {
  resetConfigCache();
  configDir = fs.mkdtempSync(path.join(os.tmpdir(), "jobblast-language-test-"));
});

afterEach(() => {
  resetConfigCache();
  delete process.env["JOBBLAST_CONFIG"];
  fs.rmSync(configDir, { recursive: true, force: true });
});

function useCandidateConfig(candidate: Record<string, unknown>): void {
  const file = path.join(configDir, "jobblast.config.json");
  fs.writeFileSync(file, JSON.stringify({ candidate }), "utf8");
  process.env["JOBBLAST_CONFIG"] = file;
}

describe("letterLanguageRule", () => {
  it("defaults to English when there is no config file", () => {
    process.env["JOBBLAST_CONFIG"] = path.join(configDir, "nonexistent.json");
    expect(letterLanguageRule()).toEqual({ letterLanguageNames: "English", fallbackLanguageName: "English" });
  });

  it("resolves a French-only candidate config", () => {
    useCandidateConfig({ letterLanguages: ["fr"], fallbackLetterLanguage: "en" });
    expect(letterLanguageRule()).toEqual({ letterLanguageNames: "French", fallbackLanguageName: "English" });
  });

  it("joins several letter languages with 'or', and resolves the fallback separately", () => {
    useCandidateConfig({ letterLanguages: ["fr", "en"], fallbackLetterLanguage: "fr" });
    expect(letterLanguageRule()).toEqual({
      letterLanguageNames: "French or English",
      fallbackLanguageName: "French",
    });
  });

  it("passes an unrecognized ISO code through unchanged", () => {
    useCandidateConfig({ letterLanguages: ["xx"], fallbackLetterLanguage: "xx" });
    expect(letterLanguageRule()).toEqual({ letterLanguageNames: "xx", fallbackLanguageName: "xx" });
  });
});
