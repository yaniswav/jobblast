// The pluggable email transport (G2 lot): `none` (default - log a
// structured line and do nothing else, never an error) or `smtp`
// (JOBBLAST_SMTP_* + JOBBLAST_EMAIL_FROM, sent through smtp-client.ts).
//
// Callers (routes/auth.ts's forgot-password handler, lib/queue/handlers.ts's
// inactivity-warning job) never touch SMTP directly - they call sendEmail()
// and let this module decide whether anything actually goes out. That is
// also the single fail-safe choke point the rest of the app relies on:
// isEmailEnabled() is false whenever nothing would actually be sent, so a
// misconfigured "smtp" transport (host set, from missing, whatever) behaves
// exactly like "none" for every caller that checks it first - never an
// inactivity purge silently running because the operator half-configured
// SMTP (docs/SAAS-ARCHITECTURE.md open question 3's warning-before-delete
// rule, tightened by the G2 brief: no working email means no warning and no
// deletion, ever).

import crypto from "node:crypto";
import { logger } from "../logger";
import { sendSmtpMessage, type SmtpConfig } from "./smtp-client";

export type EmailTransportKind = "none" | "smtp";

function envValue(name: string): string | null {
  const raw = process.env[name]?.trim();
  return raw ? raw : null;
}

/** Which transport is selected. Unset, empty or unrecognized all mean "none" - never sends by accident. */
export function emailTransportKind(): EmailTransportKind {
  return envValue("JOBBLAST_EMAIL_TRANSPORT") === "smtp" ? "smtp" : "none";
}

export type SmtpEnvConfig = {
  host: string;
  port: number;
  user: string | null;
  pass: string | null;
  from: string;
};

/** Reads and validates the JOBBLAST_SMTP_* / JOBBLAST_EMAIL_FROM group. Null when incomplete or malformed. */
export function smtpConfigFromEnv(): SmtpEnvConfig | null {
  const host = envValue("JOBBLAST_SMTP_HOST");
  const from = envValue("JOBBLAST_EMAIL_FROM");
  if (!host || !from) return null;

  const rawPort = envValue("JOBBLAST_SMTP_PORT");
  const port = rawPort ? Number(rawPort) : 587;
  if (!Number.isInteger(port) || port <= 0 || port > 65535) return null;

  return { host, port, user: envValue("JOBBLAST_SMTP_USER"), pass: envValue("JOBBLAST_SMTP_PASS"), from };
}

/**
 * True only when a message sent through sendEmail() would actually leave the
 * process: transport is "smtp" AND the env group is complete. Every caller
 * that gates user-visible behavior on "can we email this account" (the
 * forgot-password link in the frontend, the inactivity-purge job) checks
 * this rather than emailTransportKind() directly.
 */
export function isEmailEnabled(): boolean {
  return emailTransportKind() === "smtp" && smtpConfigFromEnv() !== null;
}

export type SendEmailInput = {
  to: string;
  subject: string;
  text: string;
  html: string;
};

/** Short, non-reversible-in-practice correlation id for a log line - never the address itself (docs/SAAS-ARCHITECTURE.md section 8's logging rule). */
function hashForLog(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex").slice(0, 12);
}

/**
 * Sends one email, or logs and returns immediately when the transport is
 * "none". Throws on a real SMTP failure so a caller that must know (the
 * inactivity job should not mark its one-time warning as sent if the email
 * never left) can react; a caller that must never leak send failures into
 * its response (forgot-password, always 200) catches and logs instead.
 */
export async function sendEmail(input: SendEmailInput): Promise<void> {
  const toHash = hashForLog(input.to);

  if (emailTransportKind() === "none") {
    logger.info({ toHash, subject: input.subject, transport: "none" }, "Email: transport is none, not sending");
    return;
  }

  const config = smtpConfigFromEnv();
  if (!config) {
    logger.error(
      { toHash },
      "Email: JOBBLAST_EMAIL_TRANSPORT=smtp but JOBBLAST_SMTP_HOST / JOBBLAST_EMAIL_FROM are not both set",
    );
    throw new Error("SMTP transport is selected but not fully configured");
  }

  const smtpConfig: SmtpConfig = {
    host: config.host,
    port: config.port,
    user: config.user,
    pass: config.pass,
    from: config.from,
  };

  await sendSmtpMessage(smtpConfig, {
    to: input.to,
    subject: input.subject,
    text: input.text,
    html: input.html,
  });
  logger.info({ toHash, subject: input.subject }, "Email: sent");
}

export { resetPasswordEmail, inactivityWarningEmail, resolveEmailLocale, type EmailLocale } from "./templates";
