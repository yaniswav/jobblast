// Pure MIME construction for a minimal text+html email. No mail library:
// the whole point of the hand-rolled transport (see smtp-client.ts's doc
// comment for the dependency decision) is that this stays small enough to
// read end to end, and testable without a socket.

import { randomUUID } from "node:crypto";

/** Strips CR/LF from a header value: a bare newline in a header is header
 * injection (extra headers, a forged Bcc), never legitimate content. `to`
 * traces back to the account's own stored email (validated at registration),
 * but defending the boundary here costs nothing and does not rely on every
 * caller remembering to sanitize first. */
export function sanitizeHeaderValue(value: string): string {
  return value.replace(/[\r\n]+/g, " ").trim();
}

/** RFC 2047 encoded-word, only when needed - plain ASCII (the common case
 * for an email address, and for the English template) passes through
 * unchanged rather than paying for base64 it does not need. */
export function encodeHeaderValue(value: string): string {
  const clean = sanitizeHeaderValue(value);
  // Intentional: this is the full 7-bit ASCII range, the set that never
  // needs base64 encoding.
  // eslint-disable-next-line no-control-regex
  if (/^[\x00-\x7f]*$/.test(clean)) return clean;
  return `=?UTF-8?B?${Buffer.from(clean, "utf8").toString("base64")}?=`;
}

export type MimeMessageInput = {
  from: string;
  to: string;
  subject: string;
  text: string;
  html: string;
  /** Injectable for tests; defaults to the real clock. */
  date?: Date;
  /** Injectable for tests; defaults to a fresh random id. */
  messageId?: string;
};

const CRLF = "\r\n";

/** Base64-wraps a body at the conventional 76-column MIME line length. */
function wrapBase64(value: string): string {
  const encoded = Buffer.from(value, "utf8").toString("base64");
  const lines: string[] = [];
  for (let i = 0; i < encoded.length; i += 76) lines.push(encoded.slice(i, i + 76));
  return lines.join(CRLF);
}

/**
 * Builds a complete `multipart/alternative` message (headers + body), CRLF
 * throughout as SMTP requires. Both parts are base64-encoded: it sidesteps
 * line-length limits and stray-dot ambiguity in the raw text without a
 * quoted-printable encoder, at the cost of a slightly bigger payload that
 * nobody but a mail server ever sees.
 */
export function buildMimeMessage(input: MimeMessageInput): string {
  const id = randomUUID();
  const boundary = `jobblast-${id.replace(/[^a-zA-Z0-9]/g, "")}`;
  const date = (input.date ?? new Date()).toUTCString();
  const messageId = input.messageId ?? `<${id}@jobblast>`;

  const headers = [
    `From: ${sanitizeHeaderValue(input.from)}`,
    `To: ${sanitizeHeaderValue(input.to)}`,
    `Subject: ${encodeHeaderValue(input.subject)}`,
    `Date: ${date}`,
    `Message-ID: ${messageId}`,
    "MIME-Version: 1.0",
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
  ].join(CRLF);

  const textPart = [
    `--${boundary}`,
    `Content-Type: text/plain; charset="utf-8"`,
    "Content-Transfer-Encoding: base64",
    "",
    wrapBase64(input.text),
  ].join(CRLF);

  const htmlPart = [
    `--${boundary}`,
    `Content-Type: text/html; charset="utf-8"`,
    "Content-Transfer-Encoding: base64",
    "",
    wrapBase64(input.html),
  ].join(CRLF);

  return [headers, "", textPart, htmlPart, `--${boundary}--`, ""].join(CRLF);
}
