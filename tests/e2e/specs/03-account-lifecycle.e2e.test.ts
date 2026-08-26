// Password reset end-to-end through Mailpit (the "dev" Compose profile,
// docs/DOCKER.md section 11), then account export and self-service deletion
// (docs/SAAS-ARCHITECTURE.md section 8).
//
// One POST /auth/register call in this file - see
// 01-golden-path.e2e.test.ts's comment on the shared registerIpLimiter
// budget (5/hour/IP across the whole suite).

import { beforeAll, describe, expect, it } from "vitest";
import { del, get, newSession, post, testEmail, testPassword, type Session } from "../lib/client";
import { mintInviteCode } from "../lib/invite";
import { extractResetToken, waitForEmailTo } from "../lib/mailpit";

type AccountExport = { user: { email: string }; profile: unknown };

describe("password reset, export and account deletion", () => {
  const email = testEmail("lifecycle");
  const oldPassword = testPassword("lifecycle-old");
  const newPassword = testPassword("lifecycle-new");
  const session: Session = newSession();

  beforeAll(async () => {
    const inviteCode = await mintInviteCode("lifecycle");
    const res = await post(session, "/auth/register", {
      inviteCode,
      email,
      password: oldPassword,
      displayName: "Lifecycle",
    });
    if (res.status !== 201) {
      throw new Error(`Setup: registration failed with status ${res.status}: ${JSON.stringify(res.data)}`);
    }
    // The reset flow below invalidates every session on the account
    // (lib/auth/store.ts's resetPassword()) - sign this one out first so the
    // test does not rely on a cookie it knows will stop working.
    await post(session, "/auth/logout");
  });

  it("sends a reset email through Mailpit and resets the password with its token", async () => {
    const forgot = await post(newSession(), "/auth/forgot", { email });
    expect(forgot.status).toBe(204);

    const message = await waitForEmailTo(email);
    const token = extractResetToken(message);
    expect(token.length).toBeGreaterThan(10);

    const reset = await post(newSession(), "/auth/reset", { token, newPassword });
    expect(reset.status).toBe(204);
  });

  it("the old password no longer works", async () => {
    const res = await post(newSession(), "/auth/login", { email, password: oldPassword });
    expect(res.status).toBe(401);
  });

  it("the new password logs in", async () => {
    const res = await post<{ user: { email: string } }>(session, "/auth/login", { email, password: newPassword });
    expect(res.status).toBe(200);
    expect(res.data.user.email).toBe(email);
  });

  it("exports the account as one JSON document", async () => {
    const res = await get<AccountExport>(session, "/account/export");
    expect(res.status).toBe(200);
    expect(res.data.user.email).toBe(email);
    // The export must never carry the password hash or anything key-shaped.
    expect(JSON.stringify(res.data)).not.toContain("passwordHash");
  });

  it("deletes the account with the current password, then every request 401s", async () => {
    const wrongPassword = await del(session, "/account", { password: "not-the-current-password" });
    expect(wrongPassword.status).toBe(401);

    const deleted = await del(session, "/account", { password: newPassword });
    expect(deleted.status).toBe(204);

    const afterDelete = await get(session, "/dashboard");
    expect(afterDelete.status).toBe(401);

    const loginAfterDelete = await post(newSession(), "/auth/login", { email, password: newPassword });
    expect(loginAfterDelete.status).toBe(401);
  });
});
