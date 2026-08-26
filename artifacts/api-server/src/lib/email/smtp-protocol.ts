// Pure parsing/formatting helpers behind the SMTP client in smtp-client.ts.
// Kept apart from the socket handling for the same reason lib/queue/fairness.ts
// is kept apart from lib/queue/store.ts: this is the part worth getting
// exactly right, and it is testable without a network.

/** One parsed SMTP reply, possibly assembled from several continuation lines. */
export type SmtpReply = { code: number; text: string };

/**
 * Parses a block of complete `\r\n`-terminated reply lines into one reply.
 * A multi-line reply uses `code-text` on every line but the last, which uses
 * `code text` (space, not dash) - RFC 5321 section 4.2.1. Returns null when
 * the block is not (yet) a complete, well-formed reply: the caller keeps
 * reading more bytes.
 */
export function parseMultilineReply(lines: readonly string[]): SmtpReply | null {
  if (lines.length === 0) return null;
  let code: number | null = null;
  const textLines: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const match = /^(\d{3})([ -])(.*)$/.exec(line);
    if (!match) return null;
    const lineCode = Number(match[1]);
    const separator = match[2];
    if (code === null) code = lineCode;
    else if (lineCode !== code) return null; // a real server never mixes codes mid-reply
    textLines.push(match[3] ?? "");

    const isLast = i === lines.length - 1;
    if (separator === " ") {
      // A final line has to be the last line in the block; a dash claims a
      // continuation follows.
      if (!isLast) return null;
      return { code: code, text: textLines.join("\n") };
    }
    if (isLast) return null; // block ends mid-continuation: incomplete, read more
  }
  return null;
}

/** True for the 2xx family: the command succeeded outright. */
export function isSuccessReply(code: number): boolean {
  return code >= 200 && code < 300;
}

/**
 * The EHLO extension keywords a server advertised, uppercased (`STARTTLS`,
 * `AUTH`, ...). `AUTH LOGIN PLAIN` becomes `{"AUTH", "LOGIN", "PLAIN"}` for a
 * simple `.has("STARTTLS")` / `.has("LOGIN")` check at the call site.
 */
export function parseEhloExtensions(replyText: string): Set<string> {
  const words = new Set<string>();
  for (const line of replyText.split("\n").slice(1)) {
    for (const word of line.trim().split(/\s+/)) {
      if (word) words.add(word.toUpperCase());
    }
  }
  return words;
}

/**
 * Doubles a leading `.` on any line, per RFC 5321 section 4.5.2: without
 * this, a message body line that happens to start with a dot would be read
 * by the server as the end-of-DATA marker instead of content.
 */
export function dotStuff(message: string): string {
  return message.replace(/(^|\r\n)\./g, "$1..");
}

/**
 * Pulls the bare address out of `"Name" <addr@host>` (or returns the input
 * unchanged when it is already bare) - what MAIL FROM/RCPT TO need, never
 * the display name.
 */
export function extractEmailAddress(value: string): string {
  const match = /<([^<>]+)>/.exec(value);
  return (match ? match[1]! : value).trim();
}
