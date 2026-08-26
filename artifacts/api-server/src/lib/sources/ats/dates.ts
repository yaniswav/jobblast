// Shared date normalization for the Company Watch adapters: every ATS
// reports "when was this posted" in a different shape (an ISO timestamp, a
// bare date, or nothing at all), and RawJob.postedDate wants one, consistent
// "YYYY-MM-DD" string, same rule as greenhouse.ts / lever.ts's own
// `toPostedDate` (kept in one place here since six new adapters need it).

/** Parses an absolute date/timestamp; falls back to today when missing or invalid. */
export function toPostedDate(raw: string | number | null | undefined): string {
  if (raw === null || raw === undefined || raw === "") return new Date().toISOString().slice(0, 10);
  const date = new Date(raw);
  if (Number.isNaN(date.getTime())) return new Date().toISOString().slice(0, 10);
  return date.toISOString().slice(0, 10);
}

/**
 * Workday's listing endpoint reports relative text ("Posted Today",
 * "Posted Yesterday", "Posted 15 Days Ago") instead of a date. Best-effort
 * parse of the common phrasing; anything unrecognized falls back to today
 * rather than guessing wrong in either direction.
 */
export function parseRelativePostedOn(text: string | null | undefined): string {
  const today = new Date();
  if (!text) return today.toISOString().slice(0, 10);
  const lower = text.toLowerCase();
  if (lower.includes("today")) return today.toISOString().slice(0, 10);
  if (lower.includes("yesterday")) {
    const d = new Date(today);
    d.setDate(d.getDate() - 1);
    return d.toISOString().slice(0, 10);
  }
  const match = /(\d+)\s*\+?\s*days?\s*ago/.exec(lower);
  if (match?.[1]) {
    const d = new Date(today);
    d.setDate(d.getDate() - Number(match[1]));
    return d.toISOString().slice(0, 10);
  }
  return today.toISOString().slice(0, 10);
}
