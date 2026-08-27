// Raw DB access for the per-application timeline (lot I1). See
// lib/db/src/schema/applicationEvents.ts for the row shape, and
// lib/application-events.ts for the fire-and-forget wrapper every caller
// actually uses - nothing outside that file (and this one's own test) should
// import insertApplicationEvent directly, or it loses the "never fails the
// caller" guarantee.
//
// See lib/repo/postings.ts for why the `userId` parameter is not optional.

import { and, desc, eq } from "drizzle-orm";
import {
  applicationEventsTable,
  db,
  type ApplicationEvent,
  type ApplicationEventKind,
} from "@workspace/db";

export type { ApplicationEvent, ApplicationEventKind } from "@workspace/db";

export type InsertApplicationEventInput = {
  applicationId: number;
  kind: ApplicationEventKind;
  payload: Record<string, unknown>;
  /** Defaults to "now" (the column default) when omitted. */
  occurredAt?: Date;
};

export async function insertApplicationEvent(
  userId: string,
  input: InsertApplicationEventInput,
): Promise<ApplicationEvent> {
  const values: typeof applicationEventsTable.$inferInsert = {
    userId,
    applicationId: input.applicationId,
    kind: input.kind,
    payload: input.payload,
  };
  // occurredAt defaults to now() at the column level - only set it when the
  // caller passed one (the backfill-shaped events: "applied" dated to
  // appliedAt, "followed_up" dated to lastFollowedUpAt).
  if (input.occurredAt) values.occurredAt = input.occurredAt;

  const [row] = await db.insert(applicationEventsTable).values(values).returning();
  if (!row) throw new Error("Application event insert returned no row");
  return row;
}

/** One application's timeline, newest first. */
export async function listApplicationEvents(
  userId: string,
  applicationId: number,
): Promise<ApplicationEvent[]> {
  return db
    .select()
    .from(applicationEventsTable)
    .where(
      and(
        eq(applicationEventsTable.userId, userId),
        eq(applicationEventsTable.applicationId, applicationId),
      ),
    )
    .orderBy(desc(applicationEventsTable.occurredAt), desc(applicationEventsTable.id));
}
