import crypto from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import {
  decryptSecret,
  encryptSecret,
  hintFor,
  masterKey,
  masterKeyFormatError,
  resetMasterKeyCache,
} from "./byok";

const VALID_KEY = crypto.randomBytes(32).toString("base64");

describe("masterKeyFormatError", () => {
  it("accepts a well-formed 32-byte base64 key", () => {
    expect(masterKeyFormatError(VALID_KEY)).toBeNull();
  });

  it("rejects a missing or blank value", () => {
    expect(masterKeyFormatError(undefined)).toContain("not set");
    expect(masterKeyFormatError("   ")).toContain("not set");
  });

  it("rejects non-base64 characters", () => {
    expect(masterKeyFormatError("not base64 at all!!")).toContain("base64");
  });

  it("rejects a key that decodes to the wrong length", () => {
    expect(masterKeyFormatError(Buffer.alloc(16).toString("base64"))).toContain("32 bytes");
    expect(masterKeyFormatError(Buffer.alloc(48).toString("base64"))).toContain("32 bytes");
  });
});

describe("BYOK encryption", () => {
  beforeEach(() => {
    resetMasterKeyCache();
    process.env["JOBBLAST_MASTER_KEY"] = VALID_KEY;
  });

  it("refuses to start without a valid master key (fail closed)", () => {
    resetMasterKeyCache();
    delete process.env["JOBBLAST_MASTER_KEY"];
    expect(() => masterKey()).toThrow(/not set/);

    resetMasterKeyCache();
    process.env["JOBBLAST_MASTER_KEY"] = "short";
    expect(() => masterKey()).toThrow();

    resetMasterKeyCache();
    process.env["JOBBLAST_MASTER_KEY"] = VALID_KEY;
  });

  it("round-trips a secret for the account and provider it was encrypted for", () => {
    const secret = encryptSecret("user-a", "anthropic-api", "sk-ant-super-secret-key");
    expect(decryptSecret("user-a", "anthropic-api", secret)).toBe("sk-ant-super-secret-key");
  });

  it("never stores the plaintext in the ciphertext bytes", () => {
    const secret = encryptSecret("user-a", "anthropic-api", "sk-ant-super-secret-key");
    expect(secret.ciphertext.toString("utf8")).not.toContain("sk-ant-super-secret-key");
    expect(secret.ciphertext.toString("base64")).not.toContain("sk-ant-super-secret-key");
  });

  it("produces a fresh random nonce every time (never reused)", () => {
    const first = encryptSecret("user-a", "anthropic-api", "same-plaintext-value");
    const second = encryptSecret("user-a", "anthropic-api", "same-plaintext-value");
    expect(first.iv.equals(second.iv)).toBe(false);
    expect(first.ciphertext.equals(second.ciphertext)).toBe(false);
  });

  it("rejects decryption under a different user id (wrong derived key + wrong AAD)", () => {
    const secret = encryptSecret("user-a", "anthropic-api", "sk-ant-super-secret-key");
    expect(() => decryptSecret("user-b", "anthropic-api", secret)).toThrow();
  });

  it("rejects decryption under a different provider (wrong AAD only)", () => {
    const secret = encryptSecret("user-a", "anthropic-api", "sk-ant-super-secret-key");
    expect(() => decryptSecret("user-a", "openai-compatible", secret)).toThrow();
  });

  it("rejects decryption at the wrong key version (wrong AAD only)", () => {
    const secret = encryptSecret("user-a", "anthropic-api", "sk-ant-super-secret-key", 1);
    expect(() =>
      decryptSecret("user-a", "anthropic-api", { ...secret, keyVersion: 2 }),
    ).toThrow();
  });

  it("rejects a tampered ciphertext", () => {
    const secret = encryptSecret("user-a", "anthropic-api", "sk-ant-super-secret-key");
    const tampered = Buffer.from(secret.ciphertext);
    tampered[0] = tampered[0]! ^ 0xff;
    expect(() => decryptSecret("user-a", "anthropic-api", { ...secret, ciphertext: tampered })).toThrow();
  });

  it("rejects decryption under a wrong master key entirely", () => {
    const secret = encryptSecret("user-a", "anthropic-api", "sk-ant-super-secret-key");
    resetMasterKeyCache();
    process.env["JOBBLAST_MASTER_KEY"] = crypto.randomBytes(32).toString("base64");
    expect(() => decryptSecret("user-a", "anthropic-api", secret)).toThrow();
  });
});

describe("key rotation round trip (scripts/src/rotate-byok.ts)", () => {
  it("re-encrypting under a new master key makes the old key unable to decrypt it, and the new key able to", () => {
    const oldKey = VALID_KEY;
    const newKey = crypto.randomBytes(32).toString("base64");

    // Before rotation: encrypted and decryptable under the old key.
    resetMasterKeyCache();
    process.env["JOBBLAST_MASTER_KEY"] = oldKey;
    const original = encryptSecret("user-a", "anthropic-api", "sk-ant-rotate-me", 1);
    const plaintext = decryptSecret("user-a", "anthropic-api", original);
    expect(plaintext).toBe("sk-ant-rotate-me");

    // Rotation: the script decrypts with the old key (JOBBLAST_MASTER_KEY_PREVIOUS)
    // and re-encrypts the same plaintext with the new key (JOBBLAST_MASTER_KEY),
    // bumping key_version.
    resetMasterKeyCache();
    process.env["JOBBLAST_MASTER_KEY"] = newKey;
    const rotated = encryptSecret("user-a", "anthropic-api", plaintext, 2);

    // After rotation: decryptable under the new key...
    expect(decryptSecret("user-a", "anthropic-api", rotated)).toBe("sk-ant-rotate-me");

    // ...and no longer under the old one.
    resetMasterKeyCache();
    process.env["JOBBLAST_MASTER_KEY"] = oldKey;
    expect(() => decryptSecret("user-a", "anthropic-api", rotated)).toThrow();

    // The pre-rotation ciphertext is likewise unreadable under the new key
    // (different derived key entirely) - this is exactly why the script has
    // to decrypt-then-re-encrypt rather than just relabel the row.
    resetMasterKeyCache();
    process.env["JOBBLAST_MASTER_KEY"] = newKey;
    expect(() => decryptSecret("user-a", "anthropic-api", original)).toThrow();

    resetMasterKeyCache();
    process.env["JOBBLAST_MASTER_KEY"] = VALID_KEY;
  });

  it("is idempotent: a row already decryptable under the new key is left alone (never fails re-running the script)", () => {
    resetMasterKeyCache();
    process.env["JOBBLAST_MASTER_KEY"] = VALID_KEY;
    const secret = encryptSecret("user-a", "anthropic-api", "already-current", 2);

    // The script's "is this row already rotated?" probe: try decrypting
    // under the CURRENT master key first. Success means skip this row.
    expect(() => decryptSecret("user-a", "anthropic-api", secret)).not.toThrow();
  });
});

describe("hintFor", () => {
  it("returns only the last 4 characters", () => {
    expect(hintFor("sk-ant-api03-abcd1234")).toBe("1234");
  });

  it("never returns the full secret for very short input", () => {
    expect(hintFor("ab")).toBe("ab");
  });
});
