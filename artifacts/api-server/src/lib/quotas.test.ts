import { describe, expect, it } from "vitest";
import { checkQuota, utcDayKey } from "./quotas";

describe("checkQuota", () => {
  it("allows usage strictly under the cap", () => {
    expect(checkQuota(1, 40)).toBe(true);
    expect(checkQuota(39, 40)).toBe(true);
  });

  it("allows usage exactly at the cap (the cap-th call is allowed)", () => {
    expect(checkQuota(40, 40)).toBe(true);
  });

  it("rejects usage past the cap", () => {
    expect(checkQuota(41, 40)).toBe(false);
  });

  it("treats a null cap as unlimited, regardless of usage", () => {
    expect(checkQuota(0, null)).toBe(true);
    expect(checkQuota(1_000_000, null)).toBe(true);
  });

  it("treats a cap of 0 as never allowed", () => {
    expect(checkQuota(1, 0)).toBe(false);
  });
});

describe("utcDayKey", () => {
  it("formats as YYYY-MM-DD in UTC", () => {
    expect(utcDayKey(new Date("2026-03-01T12:00:00Z"))).toBe("2026-03-01");
  });

  it("rolls over at UTC midnight, not local midnight", () => {
    expect(utcDayKey(new Date("2026-03-01T23:59:59.999Z"))).toBe("2026-03-01");
    expect(utcDayKey(new Date("2026-03-02T00:00:00.000Z"))).toBe("2026-03-02");
  });

  it("gives two calls a second apart across the boundary different keys", () => {
    const before = utcDayKey(new Date("2026-03-01T23:59:59Z"));
    const after = utcDayKey(new Date("2026-03-02T00:00:00Z"));
    expect(before).not.toBe(after);
  });
});
