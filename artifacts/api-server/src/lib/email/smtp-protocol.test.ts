import { describe, expect, it } from "vitest";
import {
  dotStuff,
  extractEmailAddress,
  isSuccessReply,
  parseEhloExtensions,
  parseMultilineReply,
} from "./smtp-protocol";

describe("parseMultilineReply", () => {
  it("parses a single-line reply", () => {
    expect(parseMultilineReply(["220 mailserver ESMTP ready"])).toEqual({
      code: 220,
      text: "mailserver ESMTP ready",
    });
  });

  it("parses a multi-line reply, joining continuation lines with a dash", () => {
    expect(
      parseMultilineReply(["250-mailserver at your service", "250-STARTTLS", "250 AUTH LOGIN PLAIN"]),
    ).toEqual({ code: 250, text: "mailserver at your service\nSTARTTLS\nAUTH LOGIN PLAIN" });
  });

  it("returns null when the block ends mid-continuation - the caller keeps reading", () => {
    expect(parseMultilineReply(["250-mailserver at your service", "250-STARTTLS"])).toBeNull();
  });

  it("returns null on an empty block", () => {
    expect(parseMultilineReply([])).toBeNull();
  });

  it("returns null when a line does not match the code-separator-text shape", () => {
    expect(parseMultilineReply(["not a reply line"])).toBeNull();
  });

  it("returns null when continuation lines disagree on the code", () => {
    expect(parseMultilineReply(["250-first", "251 second"])).toBeNull();
  });
});

describe("isSuccessReply", () => {
  it("is true for the whole 2xx family", () => {
    expect(isSuccessReply(200)).toBe(true);
    expect(isSuccessReply(250)).toBe(true);
    expect(isSuccessReply(235)).toBe(true);
    expect(isSuccessReply(299)).toBe(true);
  });

  it("is false outside 2xx", () => {
    expect(isSuccessReply(199)).toBe(false);
    expect(isSuccessReply(300)).toBe(false);
    expect(isSuccessReply(354)).toBe(false);
    expect(isSuccessReply(550)).toBe(false);
  });
});

describe("parseEhloExtensions", () => {
  it("extracts extension keywords, skipping the greeting line", () => {
    const extensions = parseEhloExtensions("mailserver greets you\nSTARTTLS\nAUTH LOGIN PLAIN\n8BITMIME");
    expect(extensions.has("STARTTLS")).toBe(true);
    expect(extensions.has("AUTH")).toBe(true);
    expect(extensions.has("LOGIN")).toBe(true);
    expect(extensions.has("PLAIN")).toBe(true);
    expect(extensions.has("8BITMIME")).toBe(true);
    expect(extensions.has("MAILSERVER")).toBe(false); // the greeting line itself is not scanned
  });

  it("is empty for a bare greeting with no extensions advertised", () => {
    expect(parseEhloExtensions("mailserver greets you").size).toBe(0);
  });
});

describe("dotStuff", () => {
  it("doubles a leading dot on a body line", () => {
    expect(dotStuff("Hello\r\n.Not a terminator\r\nBye")).toBe("Hello\r\n..Not a terminator\r\nBye");
  });

  it("doubles a leading dot on the very first line", () => {
    expect(dotStuff(".start")).toBe("..start");
  });

  it("stuffs every dot-leading line, not just the first", () => {
    expect(dotStuff(".one\r\n.two\r\n.three")).toBe("..one\r\n..two\r\n..three");
  });

  it("leaves a line with no leading dot untouched", () => {
    expect(dotStuff("a.b.c\r\nno dot here")).toBe("a.b.c\r\nno dot here");
  });

  it("leaves a message with no dots untouched", () => {
    expect(dotStuff("plain body\r\nsecond line")).toBe("plain body\r\nsecond line");
  });
});

describe("extractEmailAddress", () => {
  it("pulls the address out of a display-name form", () => {
    expect(extractEmailAddress('"JobBlast" <no-reply@example.com>')).toBe("no-reply@example.com");
  });

  it("returns a bare address unchanged", () => {
    expect(extractEmailAddress("user@example.com")).toBe("user@example.com");
  });

  it("trims surrounding whitespace on a bare address", () => {
    expect(extractEmailAddress("  user@example.com  ")).toBe("user@example.com");
  });
});
