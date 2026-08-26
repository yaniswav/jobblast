// The golden path: invite-only registration, session, the G1 onboarding
// wizard (profile -> criteria -> byok), BYOK credential lifecycle, "refresh
// now", logout/login, and the dashboard's "first batch is on its way" state.
//
// Deliberately does NOT assert on postings actually being fetched: the
// refresh this suite triggers enqueues real jobs against real job-source
// APIs, several of which need no key and would genuinely hit the network -
// see docs/SAAS-ARCHITECTURE.md section 6. Asserting on fetched results would
// make this suite flaky and dependent on third parties. Instead this checks
// what the API guarantees deterministically: the refresh was accepted
// (`{ started: true }`) and the dashboard explains the still-empty queue as
// "pending" rather than silently empty (`firstBatchPending`).

import { afterAll, describe, expect, it } from "vitest";
import { del, get, newSession, patch, post, put, testEmail, testPassword, type Session } from "../lib/client";
import { mintInviteCode } from "../lib/invite";

type AuthSession = { mode: string; user: { id: string; email: string; displayName: string | null } | null };
type OnboardingStatus = { completed: boolean; nextStep: "profile" | "criteria" | "byok" | null };
type CredentialStatus = { provider: string; configured: boolean; hint: string | null };
type Dashboard = { queuedCount: number; firstBatchPending: boolean };

describe("golden path: invite registration through onboarding and BYOK", () => {
  const session: Session = newSession();
  const email = testEmail("golden");
  const password = testPassword("golden");

  // Leaves the local stack's database exactly as it found it, so repeated
  // local runs (docs/DOCKER.md "Running the E2E suite") do not accumulate
  // throwaway accounts. Uses a fresh session/login rather than `session`
  // itself, since the last "logout and login" tests below intentionally
  // leave that cookie's state up to whichever of them ran last.
  afterAll(async () => {
    const cleanup = newSession();
    const login = await post<{ user: { email: string } } | { error: string }>(cleanup, "/auth/login", {
      email,
      password,
    });
    if (login.status !== 200) return; // already signed out some other way; nothing to clean up
    await del(cleanup, "/account", { password });
  });

  // Only one POST /auth/register call in this whole spec file: every attempt
  // (success or failure) counts against the server's own registerIpLimiter
  // (5 per hour per IP - docs/SAAS-ARCHITECTURE.md section 2), shared across
  // the entire suite since every spec hits the same app from the same
  // machine. tests/e2e/specs/02-isolation.e2e.test.ts needs two more of that
  // budget and 03-account-lifecycle.e2e.test.ts needs one, so this file
  // spends exactly one and leaves the rest for them. Invalid-invite and
  // reused-invite rejection are exercised by the unit suite
  // (artifacts/api-server's own tests), not re-proven here.
  it("registers with a freshly minted invite code and starts a session", async () => {
    const inviteCode = await mintInviteCode("golden-path");
    const res = await post<{ mode: string; user: { id: string; email: string } }>(session, "/auth/register", {
      inviteCode,
      email,
      password,
      displayName: "Golden Path",
    });
    expect(res.status).toBe(201);
    expect(res.data.mode).toBe("saas");
    expect(res.data.user.email).toBe(email);
    expect(session.cookie).not.toBeNull();

    const sessionRes = await get<AuthSession>(session, "/auth/session");
    expect(sessionRes.status).toBe(200);
    expect(sessionRes.data.user?.email).toBe(email);
  });

  describe("onboarding wizard", () => {
    it("starts on the profile step for a brand-new account", async () => {
      const res = await get<OnboardingStatus>(session, "/onboarding/status");
      expect(res.status).toBe(200);
      expect(res.data).toEqual({ completed: false, nextStep: "profile" });
    });

    it("moves to the criteria step once a real resume is saved", async () => {
      const res = await patch(session, "/profile", {
        name: "Golden Path",
        masterResume:
          "Full-stack engineer, 6 years, TypeScript and Go, distributed systems. (e2e golden-path fixture)",
      });
      expect(res.status).toBe(200);

      const status = await get<OnboardingStatus>(session, "/onboarding/status");
      expect(status.data).toEqual({ completed: false, nextStep: "criteria" });
    });

    it("moves to the byok step once search criteria are saved", async () => {
      const res = await put(session, "/settings", {
        searchCriteria: {
          keywords: ["e2e testing"],
          targetLocationKeywords: ["Remote"],
          letterLanguages: ["en"],
        },
      });
      expect(res.status).toBe(200);

      const status = await get<OnboardingStatus>(session, "/onboarding/status");
      expect(status.data).toEqual({ completed: false, nextStep: "byok" });
    });
  });

  describe("BYOK credential lifecycle", () => {
    const provider = "anthropic-api";
    const fakeKey = "sk-ant-e2e-fake-not-a-real-key-1234";

    it("starts with no credential saved", async () => {
      const res = await get<CredentialStatus[]>(session, "/settings/ai/credentials");
      expect(res.status).toBe(200);
      const status = res.data.find((c) => c.provider === provider);
      expect(status).toEqual(expect.objectContaining({ configured: false, hint: null }));
    });

    it("saves a key and only ever returns it masked", async () => {
      const res = await put<CredentialStatus>(session, `/settings/ai/credentials/${provider}`, {
        apiKey: fakeKey,
      });
      expect(res.status).toBe(200);
      expect(res.data.configured).toBe(true);
      expect(res.data.hint).toBe(fakeKey.slice(-4));
      // The full key must never appear anywhere in the response body.
      expect(JSON.stringify(res.data)).not.toContain(fakeKey);

      const list = await get<CredentialStatus[]>(session, "/settings/ai/credentials");
      const status = list.data.find((c) => c.provider === provider);
      expect(status?.configured).toBe(true);
      expect(status?.hint).toBe(fakeKey.slice(-4));
    });

    it("deletes the key", async () => {
      const res = await del(session, `/settings/ai/credentials/${provider}`);
      expect(res.status).toBe(204);

      const list = await get<CredentialStatus[]>(session, "/settings/ai/credentials");
      const status = list.data.find((c) => c.provider === provider);
      expect(status).toEqual(expect.objectContaining({ configured: false, hint: null }));
    });
  });

  describe("finishing onboarding and the dashboard", () => {
    it("completes onboarding and reports the dashboard as pending the first batch", async () => {
      const complete = await post<{ completed: boolean }>(session, "/onboarding/complete");
      expect(complete.status).toBe(200);
      expect(complete.data.completed).toBe(true);

      const status = await get<OnboardingStatus>(session, "/onboarding/status");
      expect(status.data).toEqual({ completed: true, nextStep: null });

      const dashboard = await get<Dashboard>(session, "/dashboard");
      expect(dashboard.status).toBe(200);
      expect(dashboard.data.queuedCount).toBe(0);
      expect(dashboard.data.firstBatchPending).toBe(true);
    });

    it("accepts a manual refresh request (queued, not fetched synchronously)", async () => {
      const res = await post<{ started: boolean }>(session, "/jobs/refresh");
      expect(res.status).toBe(202);
      expect(res.data.started).toBe(true);
    });
  });

  describe("logout and login", () => {
    it("clears the session on logout", async () => {
      const res = await post(session, "/auth/logout");
      expect(res.status).toBe(204);

      const sessionRes = await get<AuthSession>(session, "/auth/session");
      expect(sessionRes.data.user).toBeNull();
    });

    it("rejects an authenticated call once signed out", async () => {
      const res = await get(session, "/dashboard");
      expect(res.status).toBe(401);
    });

    it("logs back in with the same credentials", async () => {
      const res = await post<{ user: { email: string } }>(session, "/auth/login", { email, password });
      expect(res.status).toBe(200);
      expect(res.data.user.email).toBe(email);

      const sessionRes = await get<AuthSession>(session, "/auth/session");
      expect(sessionRes.data.user?.email).toBe(email);
    });

    it("rejects the wrong password with a generic error", async () => {
      const res = await post<{ error: string }>(newSession(), "/auth/login", {
        email,
        password: "definitely-the-wrong-password-1234",
      });
      expect(res.status).toBe(401);
      expect(res.data.error.toLowerCase()).not.toContain(email.toLowerCase());
    });
  });
});
