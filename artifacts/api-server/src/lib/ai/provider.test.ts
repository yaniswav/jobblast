// The correctness fix docs/SAAS-ARCHITECTURE.md calls "the third riskiest
// step": one account's broken key must not disable AI for anybody else.
//
// The failure mode being guarded against is silent - nobody gets an error,
// letters just quietly become templates for every account - so it is worth
// asserting directly rather than trusting that the module-level variables
// really are gone.
//
// No database and no network: lib/repo/ai-credentials.ts is mocked, which is
// also what makes "a key that cannot be decrypted" easy to stage.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type OutcomeResult = { ok: boolean; error: string | null };

const decryptCredential = vi.fn<(userId: string, provider: string) => Promise<string | null>>();
const recordCredentialTestResult =
  vi.fn<(userId: string, provider: string, result: OutcomeResult) => Promise<void>>();

vi.mock("../repo/ai-credentials", () => ({
  decryptCredential: (userId: string, provider: string) => decryptCredential(userId, provider),
  recordCredentialTestResult: (userId: string, provider: string, result: OutcomeResult) =>
    recordCredentialTestResult(userId, provider, result),
}));

const USER_A = "11111111-1111-1111-1111-111111111111";
const USER_B = "22222222-2222-2222-2222-222222222222";

/**
 * Loads a fresh copy of the provider layer in one mode. IS_SAAS is resolved
 * at import time, so the mode has to be set before the module graph loads -
 * which is also the guarantee that an unset variable can never mean `saas`.
 */
async function loadProviderLayer(mode: "selfhosted" | "saas") {
  vi.resetModules();
  vi.stubEnv("JOBBLAST_MODE", mode);
  vi.stubEnv("JOBBLAST_MASTER_KEY", "");
  const provider = await import("./provider");
  const config = await import("../config");
  const userContext = await import("../user-context");
  return { ...provider, ...config, ...userContext };
}

beforeEach(() => {
  decryptCredential.mockReset();
  recordCredentialTestResult.mockReset();
  recordCredentialTestResult.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

describe("selfhosted", () => {
  it("resolves a provider without touching the database", async () => {
    const layer = await loadProviderLayer("selfhosted");
    // The default provider is claude-cli, which builds whether or not the CLI
    // is installed - it only discovers that when it is first run.
    await expect(layer.getTextProvider(USER_A)).resolves.not.toBeNull();
  });

  it("keeps no-AI mode until the process restarts", async () => {
    const layer = await loadProviderLayer("selfhosted");
    vi.useFakeTimers();

    layer.disableAiForUser(USER_A, "claude CLI not on PATH");
    await vi.advanceTimersByTimeAsync(30 * 24 * 60 * 60 * 1000);

    // A missing CLI is not something a running process can fix, so unlike
    // saas there is deliberately no TTL that would retry it forever.
    expect(await layer.getTextProvider(USER_A)).toBeNull();
    expect(layer.aiDisabledReason(USER_A)).toBe("claude CLI not on PATH");
  });
});

describe("saas: one account's failure never reaches another", () => {
  /** Both accounts on anthropic-api, each with its own primed config. */
  async function twoAccounts() {
    const layer = await loadProviderLayer("saas");
    const config = layer.JobBlastConfigSchema.parse({ ai: { provider: "anthropic-api" } });
    layer.setUserConfig(USER_A, config);
    layer.setUserConfig(USER_B, config);
    return layer;
  }

  it("disables AI for the failing account only", async () => {
    const layer = await twoAccounts();

    layer.disableAiForUser(USER_A, "401 invalid x-api-key");

    expect(await layer.getTextProvider(USER_A)).toBeNull();
    expect(layer.aiDisabledReason(USER_A)).toBe("401 invalid x-api-key");

    // The whole point: B never asked for anything and must be untouched.
    expect(await layer.getTextProvider(USER_B)).not.toBeNull();
    expect(layer.aiDisabledReason(USER_B)).toBeNull();
  });

  it("lets a disabled account try again after the TTL, without a restart", async () => {
    const layer = await twoAccounts();
    vi.useFakeTimers();

    layer.disableAiForUser(USER_A, "429 rate limited");
    expect(await layer.getTextProvider(USER_A)).toBeNull();

    await vi.advanceTimersByTimeAsync(16 * 60 * 1000);

    // The user can fix their own key from Settings, and a provider-side
    // outage ends on its own, so saas retries rather than staying off forever.
    expect(await layer.getTextProvider(USER_A)).not.toBeNull();
  });

  it("forgets one account's provider without forgetting the others", async () => {
    const layer = await twoAccounts();

    layer.disableAiForUser(USER_A, "bad key");
    layer.disableAiForUser(USER_B, "bad key");

    layer.forgetUserProvider(USER_A);

    expect(layer.aiDisabledReason(USER_A)).toBeNull();
    expect(layer.aiDisabledReason(USER_B)).toBe("bad key");
  });

  it("records a failed call on the failing account's credential row", async () => {
    const layer = await twoAccounts();
    // No key saved for A: the resolver refuses, which is the same shape as a
    // key the provider rejects, and is what feeds the outage banner.
    decryptCredential.mockResolvedValue(null);

    await layer.runWithUser(USER_A, async () => {
      const provider = await layer.getTextProvider(USER_A);
      await expect(provider?.generateText("hello")).rejects.toThrow(/no api key/i);
    });

    expect(recordCredentialTestResult).toHaveBeenCalledTimes(1);
    const call = recordCredentialTestResult.mock.calls[0];
    expect(call?.[0]).toBe(USER_A);
    expect(call?.[1]).toBe("anthropic-api");
    expect(call?.[2].ok).toBe(false);
    expect(call?.[2].error).toBeTruthy();
  });

  it("never falls back to a default when an account has no settings loaded", async () => {
    const layer = await loadProviderLayer("saas");
    // Fail closed: nothing primed must mean an error, never the file, never a
    // default, and never another account's settings.
    await expect(layer.getTextProvider(USER_A)).rejects.toThrow(/no configuration primed/i);
  });

  it("does not read the ambient account when it was handed one", async () => {
    const layer = await twoAccounts();
    layer.setUserConfig(USER_B, layer.JobBlastConfigSchema.parse({ ai: { provider: "none" } }));

    // B has AI switched off; A does not. Resolving A's provider from inside
    // B's request context must still give A's provider.
    const resolved = await layer.runWithUser(USER_B, () => layer.getTextProvider(USER_A));

    expect(resolved).not.toBeNull();
    expect(await layer.runWithUser(USER_B, () => layer.getTextProvider(USER_B))).toBeNull();
  });
});
