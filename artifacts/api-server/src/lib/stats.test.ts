import { describe, expect, it } from "vitest";
import {
  computeAverageResponseDelay,
  computeCampaignStats,
  computeFunnel,
  computeResponseRateBySource,
  computeStatsByResume,
  computeWeeklyTrend,
  startOfWeekUtc,
  TREND_WEEKS,
  type StatsApplication,
  type StatsEvent,
} from "./stats";

function application(overrides: Partial<StatsApplication> = {}): StatsApplication {
  return {
    id: 1,
    status: "approved",
    appliedAt: new Date("2026-08-01T09:00:00Z"),
    resumeVersion: "Default",
    source: "Adzuna",
    ...overrides,
  };
}

function event(overrides: Partial<StatsEvent> = {}): StatsEvent {
  return {
    applicationId: 1,
    kind: "applied",
    occurredAt: new Date("2026-08-01T09:00:00Z"),
    payload: {},
    ...overrides,
  };
}

describe("computeFunnel", () => {
  it("counts every stage, keeping rejected as its own terminal branch", () => {
    const applications = [
      application({ id: 1, status: "approved" }),
      application({ id: 2, status: "approved" }),
      application({ id: 3, status: "applied" }),
      application({ id: 4, status: "responded" }),
      application({ id: 5, status: "interview" }),
      application({ id: 6, status: "offer" }),
      application({ id: 7, status: "rejected" }),
    ];
    expect(computeFunnel(applications)).toEqual({
      toSend: 2,
      sent: 5,
      responded: 4,
      interview: 2,
      offer: 1,
      rejected: 1,
    });
  });

  it("never counts approved as sent (the honesty rule this lot must not break)", () => {
    const applications = [
      application({ id: 1, status: "approved" }),
      application({ id: 2, status: "approved" }),
      application({ id: 3, status: "approved" }),
      application({ id: 4, status: "approved" }),
    ];
    expect(computeFunnel(applications)).toEqual({
      toSend: 4,
      sent: 0,
      responded: 0,
      interview: 0,
      offer: 0,
      rejected: 0,
    });
  });

  it("returns all zeros for no applications", () => {
    expect(computeFunnel([])).toEqual({
      toSend: 0,
      sent: 0,
      responded: 0,
      interview: 0,
      offer: 0,
      rejected: 0,
    });
  });

  it("a rejection straight from applied still counts, without ever passing through responded/interview", () => {
    const applications = [application({ id: 1, status: "rejected" })];
    expect(computeFunnel(applications)).toEqual({
      toSend: 0,
      sent: 1,
      responded: 1,
      interview: 0,
      offer: 0,
      rejected: 1,
    });
  });
});

describe("computeResponseRateBySource", () => {
  it("groups by source, sent applications only, and rounds the rate", () => {
    const applications = [
      application({ id: 1, source: "Adzuna", status: "applied" }),
      application({ id: 2, source: "Adzuna", status: "responded" }),
      application({ id: 3, source: "Adzuna", status: "applied" }),
      application({ id: 4, source: "France Travail", status: "interview" }),
      application({ id: 5, source: "France Travail", status: "applied" }),
    ];
    const result = computeResponseRateBySource(applications);
    expect(result).toEqual([
      { source: "Adzuna", sent: 3, responded: 1, responseRate: 33 },
      { source: "France Travail", sent: 2, responded: 1, responseRate: 50 },
    ]);
  });

  it("excludes a source with only approved (never sent) applications", () => {
    const applications = [
      application({ id: 1, source: "ats:workday", status: "approved" }),
      application({ id: 2, source: "ats:workday", status: "approved" }),
      application({ id: 3, source: "Adzuna", status: "applied" }),
    ];
    expect(computeResponseRateBySource(applications)).toEqual([
      { source: "Adzuna", sent: 1, responded: 0, responseRate: 0 },
    ]);
  });

  it("returns an empty array with no applications at all", () => {
    expect(computeResponseRateBySource([])).toEqual([]);
  });

  it("sorts by sent descending, then source name for a tie", () => {
    const applications = [
      application({ id: 1, source: "Notion Inbox", status: "applied" }),
      application({ id: 2, source: "Adzuna", status: "applied" }),
      application({ id: 3, source: "Adzuna", status: "applied" }),
    ];
    const result = computeResponseRateBySource(applications);
    expect(result.map((row) => row.source)).toEqual(["Adzuna", "Notion Inbox"]);
  });
});

describe("computeStatsByResume", () => {
  it("returns null with only one resume label among sent applications", () => {
    const applications = [
      application({ id: 1, resumeVersion: "Backend (EN)", status: "applied" }),
      application({ id: 2, resumeVersion: "Backend (EN)", status: "responded" }),
    ];
    expect(computeStatsByResume(applications)).toBeNull();
  });

  it("returns null when a second label exists only among approved (never sent) applications", () => {
    const applications = [
      application({ id: 1, resumeVersion: "Backend (EN)", status: "applied" }),
      application({ id: 2, resumeVersion: "Internship (FR)", status: "approved" }),
    ];
    expect(computeStatsByResume(applications)).toBeNull();
  });

  it("computes sent/responded/interviews per label once at least two labels have sent applications", () => {
    const applications = [
      application({ id: 1, resumeVersion: "Backend (EN)", status: "applied" }),
      application({ id: 2, resumeVersion: "Backend (EN)", status: "interview" }),
      application({ id: 3, resumeVersion: "Backend (EN)", status: "rejected" }),
      application({ id: 4, resumeVersion: "Internship (FR)", status: "applied" }),
      application({ id: 5, resumeVersion: "Internship (FR)", status: "offer" }),
    ];
    const result = computeStatsByResume(applications);
    expect(result).toEqual([
      { resumeVersion: "Backend (EN)", sent: 3, responded: 2, interviews: 1 },
      { resumeVersion: "Internship (FR)", sent: 2, responded: 1, interviews: 1 },
    ]);
  });

  it("returns an empty-safe null for no applications", () => {
    expect(computeStatsByResume([])).toBeNull();
  });
});

describe("startOfWeekUtc", () => {
  it("a Wednesday maps back to that week's Monday", () => {
    expect(startOfWeekUtc(new Date("2026-08-26T15:30:00Z")).toISOString()).toBe(
      new Date("2026-08-24T00:00:00Z").toISOString(),
    );
  });

  it("a Sunday maps back to the Monday that started its own week, not the next one", () => {
    expect(startOfWeekUtc(new Date("2026-08-30T23:59:59Z")).toISOString()).toBe(
      new Date("2026-08-24T00:00:00Z").toISOString(),
    );
  });

  it("a Monday at midnight is its own week start", () => {
    expect(startOfWeekUtc(new Date("2026-08-24T00:00:00Z")).toISOString()).toBe(
      new Date("2026-08-24T00:00:00Z").toISOString(),
    );
  });

  it("a late-night local timestamp that is already the next UTC day buckets into the UTC day's week", () => {
    // 2026-08-30 23:30 in UTC-5 is 2026-08-31 04:30 UTC - a Monday, the start
    // of the NEXT week from the Sunday case above. Bucketing is UTC-only, so
    // this must land one week later than the prior test.
    expect(startOfWeekUtc(new Date("2026-08-31T04:30:00Z")).toISOString()).toBe(
      new Date("2026-08-31T00:00:00Z").toISOString(),
    );
  });
});

describe("computeWeeklyTrend", () => {
  const now = new Date("2026-08-27T12:00:00Z"); // a Thursday

  it("returns exactly TREND_WEEKS points, oldest first, zero-filled with no data", () => {
    const result = computeWeeklyTrend([], [], now);
    expect(result).toHaveLength(TREND_WEEKS);
    expect(result.every((point) => point.count === 0)).toBe(true);
    expect(result[0]!.weekStart).toBe("2026-07-06");
    expect(result[TREND_WEEKS - 1]!.weekStart).toBe("2026-08-24");
  });

  it("buckets a sent application by its applied event's occurredAt, not its appliedAt column", () => {
    const applications = [
      application({ id: 1, status: "applied", appliedAt: new Date("2026-01-01T00:00:00Z") }),
    ];
    const events = [event({ applicationId: 1, kind: "applied", occurredAt: new Date("2026-08-25T10:00:00Z") })];
    const result = computeWeeklyTrend(applications, events, now);
    const lastWeek = result[TREND_WEEKS - 1]!;
    expect(lastWeek.weekStart).toBe("2026-08-24");
    expect(lastWeek.count).toBe(1);
    expect(result.reduce((sum, point) => sum + point.count, 0)).toBe(1);
  });

  it("falls back to the application's own appliedAt when no applied event was recorded", () => {
    const applications = [
      application({ id: 1, status: "applied", appliedAt: new Date("2026-08-20T10:00:00Z") }),
    ];
    const result = computeWeeklyTrend(applications, [], now);
    const week = result.find((point) => point.weekStart === "2026-08-17");
    expect(week?.count).toBe(1);
  });

  it("never counts an approved (never sent) application", () => {
    const applications = [
      application({ id: 1, status: "approved", appliedAt: new Date("2026-08-25T10:00:00Z") }),
    ];
    const result = computeWeeklyTrend(applications, [], now);
    expect(result.every((point) => point.count === 0)).toBe(true);
  });

  it("drops an application whose timestamp falls outside the 8-week window", () => {
    const applications = [
      application({ id: 1, status: "applied", appliedAt: new Date("2020-01-01T00:00:00Z") }),
    ];
    const result = computeWeeklyTrend(applications, [], now);
    expect(result.reduce((sum, point) => sum + point.count, 0)).toBe(0);
  });

  it("a Sunday-timestamped application lands in the same week bucket as the Monday right before it", () => {
    const applications = [
      application({ id: 1, status: "applied", appliedAt: new Date("2026-08-23T23:00:00Z") }), // Sunday
      application({ id: 2, status: "applied", appliedAt: new Date("2026-08-17T00:00:00Z") }), // the prior Monday
    ];
    const result = computeWeeklyTrend(applications, [], now);
    const week = result.find((point) => point.weekStart === "2026-08-17");
    expect(week?.count).toBe(2);
  });
});

describe("computeAverageResponseDelay", () => {
  it("is null with no qualifying status_changed event", () => {
    expect(computeAverageResponseDelay([application()], [])).toEqual({ averageDays: null, sampleSize: 0 });
  });

  it("averages the delay to the first responded/interview/rejected event, from either origin", () => {
    const applications = [
      application({ id: 1, appliedAt: new Date("2026-08-01T00:00:00Z") }),
      application({ id: 2, appliedAt: new Date("2026-08-01T00:00:00Z") }),
    ];
    const events = [
      event({
        applicationId: 1,
        kind: "status_changed",
        occurredAt: new Date("2026-08-05T00:00:00Z"), // 4 days
        payload: { from: "applied", to: "responded", origin: "gmail" },
      }),
      event({
        applicationId: 2,
        kind: "status_changed",
        occurredAt: new Date("2026-08-11T00:00:00Z"), // 10 days
        payload: { from: "applied", to: "interview", origin: "manual" },
      }),
    ];
    expect(computeAverageResponseDelay(applications, events)).toEqual({ averageDays: 7, sampleSize: 2 });
  });

  it("uses the earliest qualifying event when several were recorded for one application", () => {
    const applications = [application({ id: 1, appliedAt: new Date("2026-08-01T00:00:00Z") })];
    const events = [
      event({
        applicationId: 1,
        kind: "status_changed",
        occurredAt: new Date("2026-08-10T00:00:00Z"),
        payload: { from: "applied", to: "interview", origin: "manual" },
      }),
      event({
        applicationId: 1,
        kind: "status_changed",
        occurredAt: new Date("2026-08-03T00:00:00Z"),
        payload: { from: "applied", to: "responded", origin: "gmail" },
      }),
    ];
    expect(computeAverageResponseDelay(applications, events)).toEqual({ averageDays: 2, sampleSize: 1 });
  });

  it("ignores a status_changed event whose target is offer (not a first-response signal)", () => {
    const applications = [application({ id: 1, appliedAt: new Date("2026-08-01T00:00:00Z") })];
    const events = [
      event({
        applicationId: 1,
        kind: "status_changed",
        occurredAt: new Date("2026-08-05T00:00:00Z"),
        payload: { from: "interview", to: "offer", origin: "manual" },
      }),
    ];
    expect(computeAverageResponseDelay(applications, events)).toEqual({ averageDays: null, sampleSize: 0 });
  });

  it("ignores events for an application it has no row for", () => {
    const events = [
      event({
        applicationId: 999,
        kind: "status_changed",
        occurredAt: new Date("2026-08-05T00:00:00Z"),
        payload: { from: "applied", to: "responded", origin: "gmail" },
      }),
    ];
    expect(computeAverageResponseDelay([], events)).toEqual({ averageDays: null, sampleSize: 0 });
  });

  it("rounds the average to one decimal", () => {
    const applications = [
      application({ id: 1, appliedAt: new Date("2026-08-01T00:00:00Z") }),
      application({ id: 2, appliedAt: new Date("2026-08-01T00:00:00Z") }),
      application({ id: 3, appliedAt: new Date("2026-08-01T00:00:00Z") }),
    ];
    const events = [
      event({ applicationId: 1, kind: "status_changed", occurredAt: new Date("2026-08-02T00:00:00Z"), payload: { to: "responded" } }),
      event({ applicationId: 2, kind: "status_changed", occurredAt: new Date("2026-08-03T00:00:00Z"), payload: { to: "responded" } }),
      event({ applicationId: 3, kind: "status_changed", occurredAt: new Date("2026-08-03T00:00:00Z"), payload: { to: "responded" } }),
    ];
    // (1 + 2 + 2) / 3 = 1.6666... -> 1.7
    expect(computeAverageResponseDelay(applications, events)).toEqual({ averageDays: 1.7, sampleSize: 3 });
  });
});

describe("computeCampaignStats", () => {
  it("assembles every block from the same input, on genuinely empty data", () => {
    const result = computeCampaignStats([], [], new Date("2026-08-27T00:00:00Z"));
    expect(result.funnel).toEqual({ toSend: 0, sent: 0, responded: 0, interview: 0, offer: 0, rejected: 0 });
    expect(result.bySource).toEqual([]);
    expect(result.byResume).toBeNull();
    expect(result.weeklyTrend).toHaveLength(TREND_WEEKS);
    expect(result.averageResponseDelayDays).toBeNull();
    expect(result.responseDelaySampleSize).toBe(0);
  });

  it("covers every block at once on a small realistic dataset", () => {
    const applications = [
      application({ id: 1, status: "approved", resumeVersion: "Backend (EN)", source: "Adzuna", appliedAt: new Date("2026-08-20T00:00:00Z") }),
      application({ id: 2, status: "applied", resumeVersion: "Backend (EN)", source: "Adzuna", appliedAt: new Date("2026-08-20T00:00:00Z") }),
      application({ id: 3, status: "responded", resumeVersion: "Internship (FR)", source: "France Travail", appliedAt: new Date("2026-08-13T00:00:00Z") }),
      application({ id: 4, status: "interview", resumeVersion: "Internship (FR)", source: "France Travail", appliedAt: new Date("2026-08-06T00:00:00Z") }),
    ];
    const events = [
      event({ applicationId: 3, kind: "status_changed", occurredAt: new Date("2026-08-16T00:00:00Z"), payload: { to: "responded", origin: "gmail" } }),
      event({ applicationId: 4, kind: "status_changed", occurredAt: new Date("2026-08-11T00:00:00Z"), payload: { to: "interview", origin: "manual" } }),
    ];
    const result = computeCampaignStats(applications, events, new Date("2026-08-27T00:00:00Z"));
    expect(result.funnel).toEqual({ toSend: 1, sent: 3, responded: 2, interview: 1, offer: 0, rejected: 0 });
    expect(result.bySource).toEqual([
      { source: "France Travail", sent: 2, responded: 2, responseRate: 100 },
      { source: "Adzuna", sent: 1, responded: 0, responseRate: 0 },
    ]);
    expect(result.byResume).toEqual([
      { resumeVersion: "Internship (FR)", sent: 2, responded: 2, interviews: 1 },
      { resumeVersion: "Backend (EN)", sent: 1, responded: 0, interviews: 0 },
    ]);
    expect(result.weeklyTrend.reduce((sum, point) => sum + point.count, 0)).toBe(3);
    // application 3: appliedAt Aug 13 -> respond Aug 16 = 3 days. application 4: appliedAt Aug 6 -> interview Aug 11 = 5 days. (3 + 5) / 2 = 4.
    expect(result.averageResponseDelayDays).toBe(4);
    expect(result.responseDelaySampleSize).toBe(2);
  });
});
