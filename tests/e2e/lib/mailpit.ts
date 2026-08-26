// Reads the reset-password email back out of Mailpit's HTTP API
// (docs/DOCKER.md section 11 - the "dev" Compose profile). No dependency on
// any real mail delivery: Mailpit is a local SMTP catcher that never sends
// anywhere, which is what makes this deterministic.

const MAILPIT_URL = process.env["E2E_MAILPIT_URL"] ?? "http://localhost:8025";

type MailpitAddress = { Name: string; Address: string };
type MailpitSummary = { ID: string; To: MailpitAddress[]; Subject: string };
type MailpitMessagesResponse = { messages: MailpitSummary[] };
type MailpitMessage = { Text: string; HTML: string; Subject: string };

/**
 * Polls Mailpit for the most recent message addressed to `to`, up to
 * `timeoutMs`. The E2E password-reset flow triggers the send and then reads
 * this back within the same test, so a short poll (SMTP-to-mailbox over a
 * loopback Docker network is near-instant) is enough without hardcoding a
 * fixed sleep.
 */
export async function waitForEmailTo(to: string, timeoutMs = 10_000): Promise<MailpitMessage> {
  const deadline = Date.now() + timeoutMs;
  const target = to.toLowerCase();

  while (Date.now() < deadline) {
    const listRes = await fetch(`${MAILPIT_URL}/api/v1/messages`);
    if (listRes.ok) {
      const list = (await listRes.json()) as MailpitMessagesResponse;
      const found = list.messages.find((m) => m.To.some((addr) => addr.Address.toLowerCase() === target));
      if (found) {
        const detailRes = await fetch(`${MAILPIT_URL}/api/v1/message/${found.ID}`);
        if (detailRes.ok) return (await detailRes.json()) as MailpitMessage;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  throw new Error(`No email arrived at Mailpit (${MAILPIT_URL}) for ${to} within ${timeoutMs}ms`);
}

/** Pulls the `?token=...` value out of the reset link (lib/email/templates.ts's resetPasswordEmail). */
export function extractResetToken(message: MailpitMessage): string {
  const match = /[?&]token=([^&\s"]+)/.exec(message.Text);
  if (!match?.[1]) {
    throw new Error(`Could not find a "token=" query param in the reset email:\n${message.Text}`);
  }
  return decodeURIComponent(match[1]);
}
