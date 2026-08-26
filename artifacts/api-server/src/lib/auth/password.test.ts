import { describe, expect, it } from "vitest";
import {
  hashPassword,
  MIN_PASSWORD_LENGTH,
  validatePassword,
  verifyPassword,
} from "./password";

describe("password hashing", () => {
  it("round-trips a password and rejects the wrong one", async () => {
    const hash = await hashPassword("correct horse battery staple");
    expect(await verifyPassword(hash, "correct horse battery staple")).toBe(true);
    expect(await verifyPassword(hash, "correct horse battery stapl")).toBe(false);
  });

  it("encodes argon2id with the OWASP baseline parameters", async () => {
    const hash = await hashPassword("a sufficiently long password");
    expect(hash.startsWith("$argon2id$")).toBe(true);
    expect(hash).toContain("m=19456,t=2,p=1");
  });

  it("produces a different hash every time (per-hash salt)", async () => {
    const [first, second] = await Promise.all([
      hashPassword("a sufficiently long password"),
      hashPassword("a sufficiently long password"),
    ]);
    expect(first).not.toBe(second);
  });

  it("never verifies against an empty stored hash (the local user)", async () => {
    expect(await verifyPassword("", "")).toBe(false);
    expect(await verifyPassword("", "anything at all here")).toBe(false);
  });

  it("returns false instead of throwing on a malformed hash", async () => {
    expect(await verifyPassword("not-a-hash", "anything at all here")).toBe(false);
  });
});

describe("validatePassword", () => {
  it("accepts a long, unremarkable password", () => {
    expect(validatePassword("a sufficiently long password")).toBeNull();
  });

  it("rejects anything shorter than the minimum", () => {
    expect(validatePassword("x".repeat(MIN_PASSWORD_LENGTH - 1))).toContain(
      String(MIN_PASSWORD_LENGTH),
    );
    expect(validatePassword("x".repeat(MIN_PASSWORD_LENGTH))).toBeNull();
  });

  it("rejects a long but very common password, case-insensitively", () => {
    expect(validatePassword("PasswordPassword")).not.toBeNull();
  });
});
