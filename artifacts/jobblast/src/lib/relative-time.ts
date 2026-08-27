// "3 days ago" / "il y a 3 jours" - phrased entirely by Intl, no custom
// strings to translate. Originated in pages/applications.tsx's timeline
// (lot I1); factored out here so pages/explore.tsx (lot J2, relative posting
// dates on the search cards) can reuse the exact same rendering instead of a
// second copy.

const RELATIVE_TIME_DIVISIONS: Array<{ amount: number; unit: Intl.RelativeTimeFormatUnit }> = [
  { amount: 60, unit: 'seconds' },
  { amount: 60, unit: 'minutes' },
  { amount: 24, unit: 'hours' },
  { amount: 7, unit: 'days' },
  { amount: 4.34524, unit: 'weeks' },
  { amount: 12, unit: 'months' },
  { amount: Number.POSITIVE_INFINITY, unit: 'years' },
];

export function relativeTime(date: Date, locale: string): string {
  let duration = (date.getTime() - Date.now()) / 1000;
  const rtf = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' });
  for (const division of RELATIVE_TIME_DIVISIONS) {
    if (Math.abs(duration) < division.amount) return rtf.format(Math.round(duration), division.unit);
    duration /= division.amount;
  }
  return rtf.format(Math.round(duration), 'years');
}
