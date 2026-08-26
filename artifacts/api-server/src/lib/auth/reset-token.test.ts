import { describe, expect, it } from "vitest";
import {
  generateResetToken,
  hashResetToken,
  isResetTokenUsable,
  resetTokenExpiry,
  RESET_TOKEN_TTL_MS,
} from "./reset-token";

describe("generateResetToken", () => {
  it("is 256 bits of randomness, URL-safe", () => {
    const token = generateResetToken();
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(Buffer.from(token, "base64url").length).toBe(32);
  });

  it("never repeats across calls", () => {
    const tokens = new Set(Array.from({ length: 50 }, () => generateResetToken()));
    expect(tokens.size).toBe(50);
  });
});

describe("hashResetToken", () => {
  it("is deterministic for the same token", () => {
    const token = generateResetToken();
    expect(hashResetToken(token)).toBe(hashResetToken(token));
  });

  it("never stores the raw token - the hash does not contain it", () => {
    const token = generateResetToken();
    const hash = hashResetToken(token);
    expect(hash).not.toContain(token);
    expect(hash).toMatch(/^[0-9a-f]{64}$/); // sha256 hex
  });

  it("two different tokens hash differently", () => {
    expect(hashResetToken("token-a")).not.toBe(hashResetToken("token-b"));
  });
});

describe("resetTokenExpiry", () => {
  it("is exactly 30 minutes after `now`", () => {
    expect(RESET_TOKEN_TTL_MS).toBe(30 * 60 * 1000);
    const now = 1_000_000;
    expect(resetTokenExpiry(now)).toBe(now + 30 * 60 * 1000);
  });
});

describe("isResetTokenUsable", () => {
  const now = 1_000_000;

  it("is usable before expiry and unused", () => {
    expect(isResetTokenUsable({ expiresAt: now + 1, usedAt: null }, now)).toBe(true);
  });

  it("is not usable once used, even if not yet expired", () => {
    expect(isResetTokenUsable({ expiresAt: now + 1000, usedAt: now - 1 }, now)).toBe(false);
  });

  it("is not usable the instant it expires (inclusive boundary)", () => {
    expect(isResetTokenUsable({ expiresAt: now, usedAt: null }, now)).toBe(false);
  });

  it("is not usable once expired", () => {
    expect(isResetTokenUsable({ expiresAt: now - 1, usedAt: null }, now)).toBe(false);
  });

  it("expired and used together still resolve to not usable", () => {
    expect(isResetTokenUsable({ expiresAt: now - 1, usedAt: now - 500 }, now)).toBe(false);
  });
});
