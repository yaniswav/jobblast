// Pure helper for the "Add to Google Calendar" link on a scheduled
// interview (lot I2). No OAuth, no API call - just a preremplied
// calendar.google.com URL the browser opens directly, same idea as the
// server's lib/ics.ts but for the one-click web link instead of a
// downloadable file. `text` is built by the caller (via the i18n `t()`
// function) so this module stays locale-agnostic, the way lib/suggestions.ts
// stays free of anything UI-specific.

export type GoogleCalendarEventInput = {
  /** Already-localized event title, e.g. "Interview - Senior Engineer at Acme". */
  text: string;
  location: string;
  /** UTC instant the interview starts. */
  start: Date;
  durationMinutes?: number;
};

/** Default meeting length when only a start time is known - mirrors the server's ICS_DEFAULT_DURATION_MINUTES. */
export const GOOGLE_CALENDAR_DEFAULT_DURATION_MINUTES = 60;

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

/** `YYYYMMDDTHHMMSSZ`, always UTC - the form Google Calendar's `dates` parameter expects. */
export function formatGoogleCalendarUtc(date: Date): string {
  return (
    `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}` +
    `T${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}Z`
  );
}

/** A prefilled "add event" link - opens Google Calendar with the fields already in, nothing sent anywhere until the user saves it there themselves. */
export function buildGoogleCalendarUrl(input: GoogleCalendarEventInput): string {
  const duration = input.durationMinutes ?? GOOGLE_CALENDAR_DEFAULT_DURATION_MINUTES;
  const end = new Date(input.start.getTime() + duration * 60_000);
  const params = new URLSearchParams({
    action: 'TEMPLATE',
    text: input.text,
    dates: `${formatGoogleCalendarUtc(input.start)}/${formatGoogleCalendarUtc(end)}`,
  });
  if (input.location.trim()) params.set('location', input.location.trim());
  return `https://calendar.google.com/calendar/render?${params.toString()}`;
}
