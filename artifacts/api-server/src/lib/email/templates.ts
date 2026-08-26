// Minimal bilingual email bodies (G2 lot). Two templates only - password
// reset and the inactivity-purge warning - both sober, no marketing chrome,
// no images, no em dashes. Locale preference: the account's stored UI
// locale when known, English otherwise (see callers in routes/auth.ts and
// lib/queue/handlers.ts). Bodies are UTF-8 (accented French is fine): the
// MIME builder base64-encodes both the headers (RFC 2047) and the body, so
// nothing here needs to avoid non-ASCII characters.

export type EmailLocale = "en" | "fr";

export type EmailContent = { subject: string; text: string; html: string };

/** Locale-agnostic, so callers never resolve an unsupported/undefined locale by hand. */
export function resolveEmailLocale(locale: string | null | undefined): EmailLocale {
  return locale?.trim().toLowerCase().startsWith("fr") ? "fr" : "en";
}

function wrapHtml(paragraphs: readonly string[]): string {
  const body = paragraphs.map((p) => `<p style="margin:0 0 16px;">${p}</p>`).join("\n");
  return [
    '<div style="font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;font-size:15px;line-height:1.5;color:#1a1a1a;max-width:480px;">',
    body,
    "</div>",
  ].join("\n");
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function linkHtml(url: string, label: string): string {
  const safe = escapeHtml(url);
  return `<a href="${safe}" style="color:#1a5fb4;">${escapeHtml(label)}</a>`;
}

/** Password reset link email. `link` is `${APP_ORIGIN}/reset?token=...`, TTL 30 minutes, single use. */
export function resetPasswordEmail(locale: EmailLocale, link: string): EmailContent {
  if (locale === "fr") {
    return {
      subject: "Réinitialisez votre mot de passe JobBlast",
      text: [
        "Nous avons reçu une demande de réinitialisation de votre mot de passe JobBlast.",
        "",
        "Ouvrez ce lien pour en choisir un nouveau. Il expire dans 30 minutes et ne peut être utilisé qu'une seule fois.",
        "",
        link,
        "",
        "Si vous n'êtes pas à l'origine de cette demande, vous pouvez ignorer ce message. Votre mot de passe ne sera pas modifié.",
      ].join("\n"),
      html: wrapHtml([
        "Nous avons reçu une demande de réinitialisation de votre mot de passe JobBlast.",
        `Ouvrez ce lien pour en choisir un nouveau. Il expire dans 30 minutes et ne peut être utilisé qu'une seule fois : ${linkHtml(link, "Réinitialiser le mot de passe")}`,
        "Si vous n'êtes pas à l'origine de cette demande, vous pouvez ignorer ce message. Votre mot de passe ne sera pas modifié.",
      ]),
    };
  }
  return {
    subject: "Reset your JobBlast password",
    text: [
      "We received a request to reset your JobBlast password.",
      "",
      "Open this link to choose a new one. It expires in 30 minutes and can only be used once.",
      "",
      link,
      "",
      "If you did not request this, you can ignore this email. Your password will not change.",
    ].join("\n"),
    html: wrapHtml([
      "We received a request to reset your JobBlast password.",
      `Open this link to choose a new one. It expires in 30 minutes and can only be used once: ${linkHtml(link, "Reset password")}`,
      "If you did not request this, you can ignore this email. Your password will not change.",
    ]),
  };
}

/** 11-month inactivity warning, sent once per inactive stretch. `link` is APP_ORIGIN's sign-in page. */
export function inactivityWarningEmail(locale: EmailLocale, link: string): EmailContent {
  if (locale === "fr") {
    return {
      subject: "Votre compte JobBlast sera supprimé dans 30 jours",
      text: [
        "Votre compte JobBlast est inactif depuis un moment.",
        "",
        "Si vous ne vous reconnectez pas dans les 30 prochains jours, votre compte et ses données seront supprimés définitivement.",
        "",
        "Connectez-vous avant cette date pour le conserver :",
        "",
        link,
        "",
        "Ceci est un message automatique. Aucune action n'est nécessaire si vous prévoyez de vous reconnecter bientôt.",
      ].join("\n"),
      html: wrapHtml([
        "Votre compte JobBlast est inactif depuis un moment.",
        "Si vous ne vous reconnectez pas dans les 30 prochains jours, votre compte et ses données seront supprimés définitivement.",
        `Connectez-vous avant cette date pour le conserver : ${linkHtml(link, "Se connecter à JobBlast")}`,
        "Ceci est un message automatique. Aucune action n'est nécessaire si vous prévoyez de vous reconnecter bientôt.",
      ]),
    };
  }
  return {
    subject: "Your JobBlast account will be deleted in 30 days",
    text: [
      "Your JobBlast account has been inactive for a while.",
      "",
      "If you do not sign in within the next 30 days, your account and its data will be permanently deleted.",
      "",
      "Sign in any time before then to keep it:",
      "",
      link,
      "",
      "This is an automatic notice. No action is needed if you plan to sign in soon.",
    ].join("\n"),
    html: wrapHtml([
      "Your JobBlast account has been inactive for a while.",
      "If you do not sign in within the next 30 days, your account and its data will be permanently deleted.",
      `Sign in any time before then to keep it: ${linkHtml(link, "Sign in to JobBlast")}`,
      "This is an automatic notice. No action is needed if you plan to sign in soon.",
    ]),
  };
}
