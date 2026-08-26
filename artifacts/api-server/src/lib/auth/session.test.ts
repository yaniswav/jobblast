import { describe, expect, it } from "vitest";
import {
  DEFAULT_SESSION_POLICY,
  generateSessionToken,
  hashSessionToken,
  isExpired,
  nextExpiry,
  shouldTouch,
} from "./session";

const DAY = 24 * 60 * 60 * 1000;

describe("session tokens", () => {
  it("are url-safe and carry 256 bits", () => {
    const token = generateSessionToken();
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(Buffer.from(token, "base64url")).toHaveLength(32);
  });

  it("are never repeated", () => {
    const tokens = new Set(Array.from({ length: 200 }, generateSessionToken));
    expect(tokens.size).toBe(200);
  });

  it("hash to a stable hex digest that is not the token", () => {
    const token = generateSessionToken();
    expect(hashSessionToken(token)).toMatch(/^[0-9a-f]{64}$/);
    expect(hashSessionToken(token)).toBe(hashSessionToken(token));
    expect(hashSessionToken(token)).not.toContain(token);
  });
});

describe("nextExpiry", () => {
  const policy = DEFAULT_SESSION_POLICY;

  it("uses the idle window for a young session", () => {
    const createdAt = 0;
    const now = 1 * DAY;
    expect(nextExpiry(createdAt, now, policy)).toBe(now + policy.idleMs);
  });

  it("is capped by the absolute lifetime near the end", () => {
    const createdAt = 0;
    const now = 29 * DAY;
    expect(nextExpiry(createdAt, now, policy)).toBe(createdAt + policy.absoluteMs);
  });

  it("never extends a session past 30 days from creation", () => {
    const createdAt = 0;
    for (let day = 0; day <= 40; day++) {
      expect(nextExpiry(createdAt, day * DAY, policy)).toBeLessThanOrEqual(
        createdAt + policy.absoluteMs,
      );
    }
  });
});

describe("shouldTouch", () => {
  it("skips the write for a busy tab", () => {
    expect(shouldTouch(0, 60_000)).toBe(false);
  });

  it("writes once the throttle window has passed", () => {
    expect(shouldTouch(0, DEFAULT_SESSION_POLICY.touchAfterMs)).toBe(true);
  });
});

describe("isExpired", () => {
  it("treats the exact expiry instant as expired", () => {
    expect(isExpired(1000, 999)).toBe(false);
    expect(isExpired(1000, 1000)).toBe(true);
    expect(isExpired(1000, 1001)).toBe(true);
  });
});
