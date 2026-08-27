// Read-only queries backing GET /stats (lot I4). Every number the endpoint
// reports is computed by the pure functions in ../stats.ts from the plain
// rows these two queries return - no aggregation happens here, only joins
// and scoping. See lib/repo/postings.ts for why `userId` is not optional.

import { and, eq, inArray } from "drizzle-orm";
import {
  applicationEventsTable,
  applicationsTable,
  db,
  postingsTable,
} from "@workspace/db";
import type { StatsApplication, StatsEvent } from "../stats";

export type { StatsApplication, StatsEvent } from "../stats";

/** One row per tracked application, joined with the source of the posting it came from. */
export async function listApplicationsForStats(userId: string): Promise<StatsApplication[]> {
  return db
    .select({
      id: applicationsTable.id,
      status: applicationsTable.status,
      appliedAt: applicationsTable.appliedAt,
      resumeVersion: applicationsTable.resumeVersion,
      source: postingsTable.source,
    })
    .from(applicationsTable)
    .innerJoin(postingsTable, eq(postingsTable.id, applicationsTable.jobId))
    .where(eq(applicationsTable.userId, userId));
}

/** The two event kinds the stats aggregations read - see ../stats.ts's computeWeeklyTrend and computeAverageResponseDelay. */
const STATS_EVENT_KINDS = ["applied", "status_changed"] as const;

export async function listEventsForStats(userId: string): Promise<StatsEvent[]> {
  const rows = await db
    .select({
      applicationId: applicationEventsTable.applicationId,
      kind: applicationEventsTable.kind,
      occurredAt: applicationEventsTable.occurredAt,
      payload: applicationEventsTable.payload,
    })
    .from(applicationEventsTable)
    .where(
      and(
        eq(applicationEventsTable.userId, userId),
        inArray(applicationEventsTable.kind, STATS_EVENT_KINDS),
      ),
    );
  return rows;
}
