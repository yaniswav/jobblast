// Isolation between two accounts (docs/SAAS-ARCHITECTURE.md section 4):
// account B sets profile, search-criteria and BYOK data; account C, created
// after and never touching any of it, must see none of it.
//
// Search-criteria keywords are checked against a random, unguessable marker
// rather than "is empty" - GET /settings reads through the Zod-defaulted
// config (lib/config-store.ts's readSearchCriteria()), whose schema default
// for franceTravail.keywords is the *owner's own* non-empty example list
// (see lib/onboarding.ts's comment on why onboarding detection reads the raw
// stored row instead of this same defaulted view). A marker only B could have
// set is the isolation signal that survives that default either way.
//
// Two POST /auth/register calls in this file - see
// 01-golden-path.e2e.test.ts's comment on the shared registerIpLimiter
// budget (5/hour/IP across the whole suite).

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { del, get, newSession, patch, post, put, testEmail, testPassword, type Session } from "../lib/client";
import { mintInviteCode } from "../lib/invite";

type Profile = { name: string };
type SettingsState = { searchCriteria: { keywords: string[]; targetLocationKeywords: string[] } };
type CredentialStatus = { provider: string; configured: boolean };
type FreshAccount = { session: Session; password: string };

async function registerFreshAccount(label: string): Promise<FreshAccount> {
  const session = newSession();
  const password = testPassword(label);
  const inviteCode = await mintInviteCode(label);
  const res = await post(session, "/auth/register", {
    inviteCode,
    email: testEmail(label),
    password,
    displayName: label,
  });
  if (res.status !== 201) {
    throw new Error(`Setup: registering account "${label}" failed with status ${res.status}: ${JSON.stringify(res.data)}`);
  }
  return { session, password };
}

describe("isolation between two accounts", () => {
  const marker = `isolation-marker-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  let b: FreshAccount;
  let c: FreshAccount;
  let accountB: Session;
  let accountC: Session;

  beforeAll(async () => {
    b = await registerFreshAccount("isolation-b");
    c = await registerFreshAccount("isolation-c");
    accountB = b.session;
    accountC = c.session;

    await patch(accountB, "/profile", { name: marker });
    await put(accountB, "/settings", {
      searchCriteria: { keywords: [marker], targetLocationKeywords: [marker], letterLanguages: ["en"] },
    });
    await put(accountB, "/settings/ai/credentials/anthropic-api", { apiKey: `sk-ant-${marker}` });
  });

  // Leaves the local stack's database exactly as it found it, so repeated
  // local runs (docs/DOCKER.md "Running the E2E suite") do not accumulate
  // throwaway accounts. DELETE /account also re-proves the deletion path
  // covered end-to-end in 03-account-lifecycle.e2e.test.ts, for two more
  // accounts.
  afterAll(async () => {
    await del(accountB, "/account", { password: b.password });
    await del(accountC, "/account", { password: c.password });
  });

  it("account C's profile carries none of account B's data", async () => {
    const res = await get<Profile>(accountC, "/profile");
    expect(res.status).toBe(200);
    expect(res.data.name).not.toBe(marker);
  });

  it("account C's search criteria carry none of account B's marker", async () => {
    const res = await get<SettingsState>(accountC, "/settings");
    expect(res.status).toBe(200);
    expect(res.data.searchCriteria.keywords).not.toContain(marker);
    expect(res.data.searchCriteria.targetLocationKeywords).not.toContain(marker);
  });

  it("account C sees no BYOK credential for the provider account B configured", async () => {
    const res = await get<CredentialStatus[]>(accountC, "/settings/ai/credentials");
    expect(res.status).toBe(200);
    const status = res.data.find((c) => c.provider === "anthropic-api");
    expect(status?.configured).toBe(false);
  });

  it("account B still has its own data (the marker was actually saved, not silently dropped)", async () => {
    const profile = await get<Profile>(accountB, "/profile");
    expect(profile.data.name).toBe(marker);

    const settings = await get<SettingsState>(accountB, "/settings");
    expect(settings.data.searchCriteria.keywords).toContain(marker);

    const credentials = await get<CredentialStatus[]>(accountB, "/settings/ai/credentials");
    const status = credentials.data.find((c) => c.provider === "anthropic-api");
    expect(status?.configured).toBe(true);
  });
});
