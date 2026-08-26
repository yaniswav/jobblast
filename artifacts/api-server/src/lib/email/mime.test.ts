import { describe, expect, it } from "vitest";
import { buildMimeMessage, encodeHeaderValue, sanitizeHeaderValue } from "./mime";

describe("sanitizeHeaderValue", () => {
  it("strips embedded CR/LF - the header-injection vector", () => {
    expect(sanitizeHeaderValue("evil@example.com\r\nBcc: victim@example.com")).toBe(
      "evil@example.com Bcc: victim@example.com",
    );
  });

  it("leaves an ordinary value untouched", () => {
    expect(sanitizeHeaderValue("JobBlast <no-reply@example.com>")).toBe("JobBlast <no-reply@example.com>");
  });
});

describe("encodeHeaderValue", () => {
  it("passes plain ASCII through unchanged", () => {
    expect(encodeHeaderValue("Reset your JobBlast password")).toBe("Reset your JobBlast password");
  });

  it("RFC 2047-encodes non-ASCII as base64", () => {
    const encoded = encodeHeaderValue("Réinitialisez votre mot de passe");
    expect(encoded).toMatch(/^=\?UTF-8\?B\?.+\?=$/);
    const base64 = /^=\?UTF-8\?B\?(.+)\?=$/.exec(encoded)![1]!;
    expect(Buffer.from(base64, "base64").toString("utf8")).toBe("Réinitialisez votre mot de passe");
  });
});

describe("buildMimeMessage", () => {
  const base = {
    from: "JobBlast <no-reply@example.com>",
    to: "user@example.com",
    subject: "Reset your JobBlast password",
    text: "Open this link.",
    html: "<p>Open this link.</p>",
    date: new Date("2026-01-15T10:00:00Z"),
    messageId: "<fixed-id@jobblast>",
  };

  it("uses CRLF line endings throughout, as SMTP requires", () => {
    const message = buildMimeMessage(base);
    expect(message).not.toMatch(/(?<!\r)\n/); // every \n is preceded by \r
    expect(message.split("\r\n").length).toBeGreaterThan(5);
  });

  it("carries From/To/Subject/Message-ID headers and a multipart/alternative boundary", () => {
    const message = buildMimeMessage(base);
    expect(message).toContain("From: JobBlast <no-reply@example.com>");
    expect(message).toContain("To: user@example.com");
    expect(message).toContain("Subject: Reset your JobBlast password");
    expect(message).toContain("Message-ID: <fixed-id@jobblast>");
    expect(message).toContain('Content-Type: multipart/alternative; boundary="');
  });

  it("base64-encodes both the text and html parts, recoverably", () => {
    const message = buildMimeMessage(base);
    const boundaryMatch = /boundary="([^"]+)"/.exec(message);
    expect(boundaryMatch).not.toBeNull();
    const boundary = boundaryMatch![1]!;

    // Split precisely on the real boundary marker (opening or closing), the
    // way a MIME parser would - not on a guessed generic pattern, which
    // would also match base64 characters that happen to look like it.
    const delimiter = new RegExp(`\\r\\n--${boundary}(?:--)?\\r\\n?`);
    const parts = message.split(delimiter).filter((p) => p.includes("Content-Type: text/"));
    expect(parts).toHaveLength(2);

    const decode = (part: string) => {
      const body = part.split("\r\n\r\n")[1]!;
      return Buffer.from(body.replace(/\r\n/g, ""), "base64").toString("utf8");
    };

    expect(decode(parts.find((p) => p.includes("text/plain"))!)).toBe("Open this link.");
    expect(decode(parts.find((p) => p.includes("text/html"))!)).toBe("<p>Open this link.</p>");
  });

  it("encodes an accented subject as an RFC 2047 encoded-word", () => {
    const message = buildMimeMessage({ ...base, subject: "Réinitialisez votre mot de passe" });
    expect(message).toMatch(/Subject: =\?UTF-8\?B\?/);
  });

  it("sanitizes a header-injection attempt in the `to` address", () => {
    const message = buildMimeMessage({ ...base, to: "victim@example.com\r\nBcc: everyone@example.com" });
    expect(message).not.toMatch(/\r\nBcc:/);
  });
});
