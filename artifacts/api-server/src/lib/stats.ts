// Pure aggregation logic for the campaign stats page (lot I4): every number
// GET /stats reports, derived from plain rows lib/repo/stats.ts already
// queried. No database, no I/O, no wall-clock reads - `now` is always passed
// in, same split as lib/follow-ups.ts and lib/dashboard-status.ts.
//
// "Sent" mirrors routes/dashboard.ts's own rule: status "approved" means the
// tailored application was prepared but never actually sent to the
// employer, so it must never count as sent, responded, interviewed, etc.
// below - only an explicit "I applied" (PATCH away from "approved") does.

/** The subset of an `applications` row (joined with its posting's `source`) this file reasons about. */
export type StatsApplication = {
  id: number;
  status: string;
  appliedAt: Date;
  resumeVersion: string;
  source: string;
};

/** The subset of an `application_events` row this file reasons about - kinds "applied" and "status_changed" only. */
export type StatsEvent = {
  applicationId: number;
  kind: string;
  occurredAt: Date;
  payload: Record<string, unknown>;
};

/** Any of these counts as "got a reply" - a rejection is a reply too. */
const RESPONDED_STATUSES = ["responded", "interview", "offer", "rejected"];
/** Reached interview or further. */
const INTERVIEWED_STATUSES = ["interview", "offer"];

function isSent(application: StatsApplication): boolean {
  return application.status !== "approved";
}

function hasResponded(application: StatsApplication): boolean {
  return RESPONDED_STATUSES.includes(application.status);
}

// ---------------------------------------------------------------------------
// Funnel
// ---------------------------------------------------------------------------

export type CampaignFunnel = {
  toSend: number;
  sent: number;
  responded: number;
  interview: number;
  offer: number;
  rejected: number;
};

/**
 * Counters for the six stages a tracked application can be described by.
 * Not strictly cumulative: `rejected` is its own terminal branch (a
 * rejection can land straight from "applied", skipping "responded" or
 * "interview"), counted separately rather than nested under an earlier
 * stage - see this file's header for why "approved" never counts as sent.
 */
export function computeFunnel(applications: readonly StatsApplication[]): CampaignFunnel {
  return {
    toSend: applications.filter((application) => application.status === "approved").length,
    sent: applications.filter(isSent).length,
    responded: applications.filter(hasResponded).length,
    interview: applications.filter((application) => INTERVIEWED_STATUSES.includes(application.status)).length,
    offer: applications.filter((application) => application.status === "offer").length,
    rejected: applications.filter((application) => application.status === "rejected").length,
  };
}

// ---------------------------------------------------------------------------
// Response rate by source
// ---------------------------------------------------------------------------

export type CampaignSourceStat = {
  source: string;
  sent: number;
  responded: number;
  responseRate: number;
};

/** One row per posting source, sent applications only, sources with zero sent applications excluded entirely. */
export function computeResponseRateBySource(
  applications: readonly StatsApplication[],
): CampaignSourceStat[] {
  const bySource = new Map<string, { sent: number; responded: number }>();
  for (const application of applications) {
    if (!isSent(application)) continue;
    const entry = bySource.get(application.source) ?? { sent: 0, responded: 0 };
    entry.sent += 1;
    if (hasResponded(application)) entry.responded += 1;
    bySource.set(application.source, entry);
  }
  return Array.from(bySource.entries())
    .map(([source, { sent, responded }]) => ({
      source,
      sent,
      responded,
      responseRate: sent > 0 ? Math.round((responded / sent) * 100) : 0,
    }))
    .sort((a, b) => b.sent - a.sent || a.source.localeCompare(b.source));
}

// ---------------------------------------------------------------------------
// By resume version (lot I3's resumeVersion label)
// ---------------------------------------------------------------------------

export type CampaignResumeStat = {
  resumeVersion: string;
  sent: number;
  responded: number;
  interviews: number;
};

/**
 * One row per resume label, sent applications only. Null unless at least two
 * distinct labels have a sent application - a single-row "comparison" is not
 * a comparison, so the caller shows nothing rather than a misleading table.
 */
export function computeStatsByResume(
  applications: readonly StatsApplication[],
): CampaignResumeStat[] | null {
  const byResume = new Map<string, CampaignResumeStat>();
  for (const application of applications) {
    if (!isSent(application)) continue;
    const entry = byResume.get(application.resumeVersion) ?? {
      resumeVersion: application.resumeVersion,
      sent: 0,
      responded: 0,
      interviews: 0,
    };
    entry.sent += 1;
    if (hasResponded(application)) entry.responded += 1;
    if (INTERVIEWED_STATUSES.includes(application.status)) entry.interviews += 1;
    byResume.set(application.resumeVersion, entry);
  }
  if (byResume.size < 2) return null;
  return Array.from(byResume.values()).sort(
    (a, b) => b.sent - a.sent || a.resumeVersion.localeCompare(b.resumeVersion),
  );
}

// ---------------------------------------------------------------------------
// Weekly trend
// ---------------------------------------------------------------------------

export type CampaignWeeklyTrendPoint = { weekStart: string; count: number };

const DAY_MS = 24 * 60 * 60 * 1000;
const WEEK_MS = 7 * DAY_MS;
/** How many weeks the trend covers, including the current (possibly partial) one. */
export const TREND_WEEKS = 8;

/**
 * Monday 00:00:00 UTC of the week containing `date`. Always UTC, never the
 * server's local timezone or a per-account one - the account has no stored
 * timezone, and bucketing in UTC keeps this deterministic regardless of
 * where the process runs.
 */
export function startOfWeekUtc(date: Date): Date {
  const midnight = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const day = midnight.getUTCDay(); // 0 (Sun) .. 6 (Sat)
  const daysSinceMonday = (day + 6) % 7; // Mon -> 0, Tue -> 1, ..., Sun -> 6
  midnight.setUTCDate(midnight.getUTCDate() - daysSinceMonday);
  return midnight;
}

/**
 * Sent applications per week, oldest first, for the last `TREND_WEEKS`
 * weeks (including the current one), zero-filled. Each application is
 * bucketed by the earliest "applied" timeline event recorded for it, falling
 * back to the application's own `appliedAt` column when that event is
 * missing (recordApplicationEvent is fire-and-forget and can fail to write -
 * see lib/application-events.ts). Only sent applications count, same rule as
 * the funnel above; approved-only rows never appear here.
 */
export function computeWeeklyTrend(
  applications: readonly StatsApplication[],
  events: readonly StatsEvent[],
  now: Date,
): CampaignWeeklyTrendPoint[] {
  const appliedEventByApplication = new Map<number, Date>();
  for (const event of events) {
    if (event.kind !== "applied") continue;
    const existing = appliedEventByApplication.get(event.applicationId);
    if (!existing || event.occurredAt.getTime() < existing.getTime()) {
      appliedEventByApplication.set(event.applicationId, event.occurredAt);
    }
  }

  const currentWeekStart = startOfWeekUtc(now);
  const weekStarts: Date[] = [];
  for (let i = TREND_WEEKS - 1; i >= 0; i -= 1) {
    weekStarts.push(new Date(currentWeekStart.getTime() - i * WEEK_MS));
  }
  const counts = new Map<number, number>(weekStarts.map((weekStart) => [weekStart.getTime(), 0]));
  const earliestWeekMs = weekStarts[0]!.getTime();
  const afterLatestWeekMs = weekStarts[weekStarts.length - 1]!.getTime() + WEEK_MS;

  for (const application of applications) {
    if (!isSent(application)) continue;
    const timestamp = appliedEventByApplication.get(application.id) ?? application.appliedAt;
    const bucketMs = startOfWeekUtc(timestamp).getTime();
    if (bucketMs < earliestWeekMs || bucketMs >= afterLatestWeekMs) continue;
    counts.set(bucketMs, (counts.get(bucketMs) ?? 0) + 1);
  }

  return weekStarts.map((weekStart) => ({
    weekStart: weekStart.toISOString().slice(0, 10),
    count: counts.get(weekStart.getTime()) ?? 0,
  }));
}

// ---------------------------------------------------------------------------
// Average first-response delay
// ---------------------------------------------------------------------------

export type CampaignResponseDelay = { averageDays: number | null; sampleSize: number };

/** The status_changed targets that count as "a first response happened", from either origin. */
const FIRST_RESPONSE_TARGET_STATUSES = ["responded", "interview", "rejected"];

/**
 * Average whole-ish days from `appliedAt` to the first status_changed event
 * that moved an application to responded, interview or rejected - whichever
 * came first, from either origin ("manual" or "gmail", both are real
 * transitions). `offer` is deliberately excluded: by the time a row reaches
 * offer it has already passed through one of these three, so including it
 * would double-count rather than add a new "first response" signal. Null
 * average (with sampleSize 0) until at least one application qualifies.
 */
export function computeAverageResponseDelay(
  applications: readonly StatsApplication[],
  events: readonly StatsEvent[],
): CampaignResponseDelay {
  const appliedAtById = new Map(applications.map((application) => [application.id, application.appliedAt]));
  const firstResponseByApplication = new Map<number, Date>();

  for (const event of events) {
    if (event.kind !== "status_changed") continue;
    const to = event.payload["to"];
    if (typeof to !== "string" || !FIRST_RESPONSE_TARGET_STATUSES.includes(to)) continue;
    const existing = firstResponseByApplication.get(event.applicationId);
    if (!existing || event.occurredAt.getTime() < existing.getTime()) {
      firstResponseByApplication.set(event.applicationId, event.occurredAt);
    }
  }

  const delaysMs: number[] = [];
  for (const [applicationId, respondedAt] of firstResponseByApplication) {
    const appliedAt = appliedAtById.get(applicationId);
    if (!appliedAt) continue;
    const delta = respondedAt.getTime() - appliedAt.getTime();
    if (delta >= 0) delaysMs.push(delta);
  }

  if (delaysMs.length === 0) return { averageDays: null, sampleSize: 0 };
  const averageMs = delaysMs.reduce((sum, ms) => sum + ms, 0) / delaysMs.length;
  return { averageDays: Math.round((averageMs / DAY_MS) * 10) / 10, sampleSize: delaysMs.length };
}

// ---------------------------------------------------------------------------
// Everything the route returns, in one call
// ---------------------------------------------------------------------------

export type CampaignStats = {
  funnel: CampaignFunnel;
  bySource: CampaignSourceStat[];
  byResume: CampaignResumeStat[] | null;
  weeklyTrend: CampaignWeeklyTrendPoint[];
  averageResponseDelayDays: number | null;
  responseDelaySampleSize: number;
};

export function computeCampaignStats(
  applications: readonly StatsApplication[],
  events: readonly StatsEvent[],
  now: Date,
): CampaignStats {
  const delay = computeAverageResponseDelay(applications, events);
  return {
    funnel: computeFunnel(applications),
    bySource: computeResponseRateBySource(applications),
    byResume: computeStatsByResume(applications),
    weeklyTrend: computeWeeklyTrend(applications, events, now),
    averageResponseDelayDays: delay.averageDays,
    responseDelaySampleSize: delay.sampleSize,
  };
}
