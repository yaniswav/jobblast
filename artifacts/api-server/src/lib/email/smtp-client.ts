// A minimal SMTP client: connect, EHLO, STARTTLS when offered, AUTH LOGIN
// when configured, MAIL FROM / RCPT TO / DATA, QUIT. Roughly 150 lines
// against `node:net` / `node:tls`.
//
// Dependency decision (see the G2 brief): the architecture doc
// (docs/SAAS-ARCHITECTURE.md section 2) named `nodemailer` for this, and it
// is already pre-listed in build.mjs's esbuild externals "in case", so
// reaching for it would have been zero-friction. This file exists instead
// because the actual job is small and well-specified - talk plaintext SMTP
// to exactly one relay, for exactly one plain-text-plus-html message, no
// attachments, no connection pooling, no DKIM signing - and free relays that
// fit the "$0" constraint (Brevo, Resend, Mailpit locally) all speak
// textbook EHLO/STARTTLS/AUTH LOGIN with nothing exotic. That is a better
// fit for ~150 read-once lines than for a dependency whose real surface (MIME
// attachments, OAuth2, connection pooling, calendar invites) this app will
// never touch. If a relay shows up that needs something outside this
// (PLAIN/XOAUTH2, pipelining, 8BITMIME) - swap this module for `nodemailer`
// then; nothing outside lib/email/ would need to change.

import net from "node:net";
import tls, { type TLSSocket } from "node:tls";
import { buildMimeMessage } from "./mime";
import {
  dotStuff,
  extractEmailAddress,
  isSuccessReply,
  parseEhloExtensions,
  parseMultilineReply,
  type SmtpReply,
} from "./smtp-protocol";

export type SmtpConfig = {
  host: string;
  port: number;
  user?: string | null | undefined;
  pass?: string | null | undefined;
  /** The `From:` header - may be a bare address or `"Name" <addr>`. */
  from: string;
  connectTimeoutMs?: number;
};

export type SmtpMessage = {
  to: string;
  subject: string;
  text: string;
  html: string;
};

type Socket = net.Socket | TLSSocket;

const DEFAULT_TIMEOUT_MS = 10_000;
const HELO_NAME = "jobblast";

function nextChunk(socket: Socket, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("SMTP: timed out waiting for a reply"));
    }, timeoutMs);
    const onData = (chunk: Buffer) => {
      cleanup();
      resolve(chunk.toString("utf8"));
    };
    const onError = (err: Error) => {
      cleanup();
      reject(err);
    };
    const onClose = () => {
      cleanup();
      reject(new Error("SMTP: connection closed before a reply arrived"));
    };
    function cleanup(): void {
      clearTimeout(timer);
      socket.off("data", onData);
      socket.off("error", onError);
      socket.off("close", onClose);
    }
    socket.once("data", onData);
    socket.once("error", onError);
    socket.once("close", onClose);
  });
}

/** Reads one complete (possibly multi-line) reply. Never logs its content: a 5xx from a misconfigured relay can echo back the command it rejected. */
async function readReply(socket: Socket, timeoutMs: number): Promise<SmtpReply> {
  let buffer = "";
  for (;;) {
    buffer += await nextChunk(socket, timeoutMs);
    const lines = buffer.split("\r\n");
    lines.pop(); // trailing partial line (or empty string if buffer ends cleanly)
    if (lines.length === 0) continue;
    const parsed = parseMultilineReply(lines);
    if (parsed) return parsed;
  }
}

function send(socket: Socket, line: string): void {
  socket.write(`${line}\r\n`, "utf8");
}

async function command(
  socket: Socket,
  line: string,
  timeoutMs: number,
  expectSuccess = true,
): Promise<SmtpReply> {
  send(socket, line);
  const reply = await readReply(socket, timeoutMs);
  if (expectSuccess && !isSuccessReply(reply.code) && reply.code !== 334 && reply.code !== 354) {
    throw new Error(`SMTP command failed with code ${reply.code}`);
  }
  return reply;
}

function connectPlain(host: string, port: number, timeoutMs: number): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host, port });
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error("SMTP: connection timed out"));
    }, timeoutMs);
    socket.once("connect", () => {
      clearTimeout(timer);
      resolve(socket);
    });
    socket.once("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

function upgradeToTls(socket: net.Socket, host: string, timeoutMs: number): Promise<TLSSocket> {
  return new Promise((resolve, reject) => {
    const secure = tls.connect({ socket, servername: host });
    const timer = setTimeout(() => {
      secure.destroy();
      reject(new Error("SMTP: TLS handshake timed out"));
    }, timeoutMs);
    secure.once("secureConnect", () => {
      clearTimeout(timer);
      resolve(secure);
    });
    secure.once("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

/**
 * Sends one email through `config.host:config.port`. Port 465 connects with
 * implicit TLS from the start (the common "SMTPS" convention); any other
 * port connects plaintext and upgrades via STARTTLS if the server offers it
 * - which is how port 587 (Brevo, Resend, most relays) works, and which
 * Mailpit's plain local listener simply never advertises, so nothing here
 * needs to know which one it is talking to.
 */
export async function sendSmtpMessage(config: SmtpConfig, message: SmtpMessage): Promise<void> {
  const timeoutMs = config.connectTimeoutMs ?? DEFAULT_TIMEOUT_MS;
  const implicitTls = config.port === 465;

  let socket: Socket = implicitTls
    ? await new Promise<TLSSocket>((resolve, reject) => {
        const secure = tls.connect({ host: config.host, port: config.port });
        const timer = setTimeout(() => {
          secure.destroy();
          reject(new Error("SMTP: TLS connection timed out"));
        }, timeoutMs);
        secure.once("secureConnect", () => {
          clearTimeout(timer);
          resolve(secure);
        });
        secure.once("error", (err) => {
          clearTimeout(timer);
          reject(err);
        });
      })
    : await connectPlain(config.host, config.port, timeoutMs);

  try {
    await readReply(socket, timeoutMs); // 220 greeting

    let extensions = parseEhloExtensions((await command(socket, `EHLO ${HELO_NAME}`, timeoutMs)).text);

    if (!implicitTls && extensions.has("STARTTLS")) {
      await command(socket, "STARTTLS", timeoutMs);
      socket = await upgradeToTls(socket as net.Socket, config.host, timeoutMs);
      extensions = parseEhloExtensions((await command(socket, `EHLO ${HELO_NAME}`, timeoutMs)).text);
    }

    if (config.user && config.pass) {
      await command(socket, "AUTH LOGIN", timeoutMs);
      await command(socket, Buffer.from(config.user, "utf8").toString("base64"), timeoutMs);
      await command(socket, Buffer.from(config.pass, "utf8").toString("base64"), timeoutMs);
    }

    await command(socket, `MAIL FROM:<${extractEmailAddress(config.from)}>`, timeoutMs);
    await command(socket, `RCPT TO:<${extractEmailAddress(message.to)}>`, timeoutMs);
    await command(socket, "DATA", timeoutMs);

    const mime = buildMimeMessage({
      from: config.from,
      to: message.to,
      subject: message.subject,
      text: message.text,
      html: message.html,
    });
    send(socket, `${dotStuff(mime)}.`);
    const reply = await readReply(socket, timeoutMs);
    if (!isSuccessReply(reply.code)) {
      throw new Error(`SMTP: relay rejected the message (code ${reply.code})`);
    }

    await command(socket, "QUIT", timeoutMs, false);
  } finally {
    socket.destroy();
  }
}
