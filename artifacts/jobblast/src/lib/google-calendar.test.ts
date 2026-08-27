// Pure-logic tests for the Google Calendar link builder (lot I2). No DOM,
// no network: URL construction is a plain string function, exercised
// directly - same spirit as suggestions.test.ts.

import { describe, expect, it } from 'vitest';
import {
  buildGoogleCalendarUrl,
  formatGoogleCalendarUtc,
  GOOGLE_CALENDAR_DEFAULT_DURATION_MINUTES,
} from './google-calendar';

describe('formatGoogleCalendarUtc', () => {
  it('formats as YYYYMMDDTHHMMSSZ in UTC', () => {
    expect(formatGoogleCalendarUtc(new Date('2026-08-30T14:05:09.000Z'))).toBe('20260830T140509Z');
  });

  it('zero-pads every component', () => {
    expect(formatGoogleCalendarUtc(new Date('2026-01-02T03:04:05.000Z'))).toBe('20260102T030405Z');
  });
});

describe('buildGoogleCalendarUrl', () => {
  const start = new Date('2026-08-30T14:00:00.000Z');

  it('points at the real Google Calendar render endpoint with action=TEMPLATE', () => {
    const url = buildGoogleCalendarUrl({ text: 'Interview - Senior Engineer at Acme', location: 'Paris, France', start });
    expect(url.startsWith('https://calendar.google.com/calendar/render?')).toBe(true);
    const params = new URL(url).searchParams;
    expect(params.get('action')).toBe('TEMPLATE');
  });

  it('carries the event text unchanged', () => {
    const url = buildGoogleCalendarUrl({ text: 'Interview - Senior Engineer at Acme', location: 'Paris', start });
    expect(new URL(url).searchParams.get('text')).toBe('Interview - Senior Engineer at Acme');
  });

  it('builds dates as start/end in UTC, defaulting to a one-hour meeting', () => {
    const url = buildGoogleCalendarUrl({ text: 'Interview', location: 'Paris', start });
    expect(new URL(url).searchParams.get('dates')).toBe('20260830T140000Z/20260830T150000Z');
    expect(GOOGLE_CALENDAR_DEFAULT_DURATION_MINUTES).toBe(60);
  });

  it('honors a custom duration', () => {
    const url = buildGoogleCalendarUrl({ text: 'Interview', location: 'Paris', start, durationMinutes: 30 });
    expect(new URL(url).searchParams.get('dates')).toBe('20260830T140000Z/20260830T143000Z');
  });

  it('includes location when set', () => {
    const url = buildGoogleCalendarUrl({ text: 'Interview', location: 'Paris, France', start });
    expect(new URL(url).searchParams.get('location')).toBe('Paris, France');
  });

  it('omits location when blank', () => {
    const url = buildGoogleCalendarUrl({ text: 'Interview', location: '   ', start });
    expect(new URL(url).searchParams.has('location')).toBe(false);
  });

  it('never includes a details parameter - no brief content, ever', () => {
    const url = buildGoogleCalendarUrl({ text: 'Interview', location: 'Paris', start });
    expect(new URL(url).searchParams.has('details')).toBe(false);
  });
});
