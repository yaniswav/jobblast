// RFC 5545 calendar generation for a scheduled interview (lot I2). Pure: no
// I/O, no env, no database - the route handler
// (routes/applications.ts's GET /applications/:id/interview.ics) gathers the
// data and this file only turns it into bytes. See ics.test.ts.
//
// Deliberately sparse: the event carries the role, the company, the
// location and the date/time, plus a one-line mention that a brief exists -
// NEVER the interview brief's own content (lib/ai/interview-brief.ts, kept
// behind auth in the app itself).

export type IcsLocale = "en" | "fr";

export type InterviewIcsInput = {
  applicationId: number;
  title: string;
  company: string;
  location: string;
  /** UTC instant the interview starts. */
  interviewAt: Date;
  /** Whether a ready interview brief exists for this application - mentioned, never quoted. */
  hasBrief: boolean;
  /** Builds the stable UID (`jobblast-app-<id>@<host>`) - pass the request's Host header, no port. */
  host: string;
  /** UI language, "en" when unknown - see lib/email/templates.ts's resolveEmailLocale for the same rule applied to e-mails. */
  locale?: IcsLocale;
  /** DTSTAMP - defaults to now. Overridable so tests are deterministic. */
  now?: Date;
};

/** Default meeting length when only a start time is known. */
export const ICS_DEFAULT_DURATION_MINUTES = 60;

/** RFC 5545 content lines are CRLF-terminated and folded at 75 octets. */
const MAX_LINE_OCTETS = 75;

function pad(value: number, length = 2): string {
  return String(value).padStart(length, "0");
}

/** `YYYYMMDDTHHMMSSZ` - the only timestamp form this file ever emits, always UTC. */
export function formatIcsUtc(date: Date): string {
  return (
    `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}` +
    `T${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}Z`
  );
}

/**
 * RFC 5545 section 3.3.11 TEXT escaping: backslash first, so it does not
 * double-escape the characters escaped after it, then semicolon, comma, and
 * any line break collapsed to a literal two-character `\n`.
 */
export function escapeIcsText(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\r\n|\r|\n/g, "\\n");
}

/**
 * Folds one already-escaped content line ("NAME:value") to RFC 5545's
 * 75-octet limit. A folded line continues on the next physical line, which
 * must start with exactly one space - the unfolding rule the parser applies
 * is to drop that CRLF + leading space pair. Splits on UTF-8 byte
 * boundaries so a folded line never lands inside a multi-byte character.
 */
export function foldIcsLine(line: string): string {
  const bytes = Buffer.from(line, "utf8");
  if (bytes.length <= MAX_LINE_OCTETS) return line;

  const chunks: string[] = [];
  let start = 0;
  // The first chunk gets the full 75 octets; every continuation chunk gets
  // 74, because the leading space it is joined with on output counts too.
  let budget = MAX_LINE_OCTETS;
  while (start < bytes.length) {
    let end = Math.min(start + budget, bytes.length);
    while (end > start && (bytes[end] & 0xc0) === 0x80) end--;
    chunks.push(bytes.subarray(start, end).toString("utf8"));
    start = end;
    budget = MAX_LINE_OCTETS - 1;
  }
  return chunks.join("\r\n ");
}

/** `jobblast-app-<id>@<host>` - stable across regenerations of the same application on the same deployment. */
export function buildInterviewUid(applicationId: number, host: string): string {
  return `jobblast-app-${applicationId}@${host}`;
}

const SUMMARY_BY_LOCALE = {
  en: (title: string, company: string) => `Interview - ${title} at ${company}`,
  fr: (title: string, company: string) => `Entretien - ${title} chez ${company}`,
} satisfies Record<IcsLocale, (title: string, company: string) => string>;

const ROLE_LINE_BY_LOCALE = {
  en: (title: string, company: string) => `${title} at ${company}`,
  fr: (title: string, company: string) => `${title} chez ${company}`,
} satisfies Record<IcsLocale, (title: string, company: string) => string>;

const BRIEF_NOTE_BY_LOCALE = {
  en: "Interview brief available in JobBlast.",
  fr: "Brief d'entretien disponible dans JobBlast.",
} satisfies Record<IcsLocale, string>;

function buildSummary(input: InterviewIcsInput, locale: IcsLocale): string {
  return SUMMARY_BY_LOCALE[locale](input.title, input.company);
}

/** Poste, entreprise, lieu, and - only when a brief actually exists - one mention it is available. Never the brief's content. */
function buildDescription(input: InterviewIcsInput, locale: IcsLocale): string {
  const lines = [ROLE_LINE_BY_LOCALE[locale](input.title, input.company)];
  if (input.location.trim()) lines.push(input.location.trim());
  if (input.hasBrief) lines.push("", BRIEF_NOTE_BY_LOCALE[locale]);
  return lines.join("\n");
}

/**
 * Builds a complete VCALENDAR/VEVENT document for one scheduled interview:
 * a stable UID, DTSTAMP/DTSTART/DTEND in UTC (a fixed
 * ICS_DEFAULT_DURATION_MINUTES-long meeting), a localized SUMMARY and a
 * sober DESCRIPTION, and a VALARM firing one hour before. CRLF throughout,
 * lines folded at 75 octets - see this file's header for what it
 * deliberately leaves out.
 */
export function buildInterviewIcs(input: InterviewIcsInput): string {
  const locale = input.locale ?? "en";
  const now = input.now ?? new Date();
  const end = new Date(input.interviewAt.getTime() + ICS_DEFAULT_DURATION_MINUTES * 60_000);
  const summary = buildSummary(input, locale);

  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//JobBlast//Interview//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    "BEGIN:VEVENT",
    `UID:${buildInterviewUid(input.applicationId, input.host)}`,
    `DTSTAMP:${formatIcsUtc(now)}`,
    `DTSTART:${formatIcsUtc(input.interviewAt)}`,
    `DTEND:${formatIcsUtc(end)}`,
    `SUMMARY:${escapeIcsText(summary)}`,
    ...(input.location.trim() ? [`LOCATION:${escapeIcsText(input.location.trim())}`] : []),
    `DESCRIPTION:${escapeIcsText(buildDescription(input, locale))}`,
    "BEGIN:VALARM",
    "ACTION:DISPLAY",
    `DESCRIPTION:${escapeIcsText(summary)}`,
    "TRIGGER:-PT1H",
    "END:VALARM",
    "END:VEVENT",
    "END:VCALENDAR",
  ];

  return lines.map(foldIcsLine).join("\r\n") + "\r\n";
}
