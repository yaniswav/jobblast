// Every query against the application tracker, scoped by account.
// See lib/repo/postings.ts for why the `userId` parameter is not optional.

import { and, desc, eq, sql } from "drizzle-orm";
import {
  applicationsTable,
  db,
  postingsTable,
  userPostingsTable,
  type Application,
} from "@workspace/db";

export type { Application } from "@workspace/db";

export async function listApplications(userId: string): Promise<Application[]> {
  return db
    .select()
    .from(applicationsTable)
    .where(eq(applicationsTable.userId, userId))
    .orderBy(desc(applicationsTable.appliedAt));
}

export async function getApplication(
  userId: string,
  applicationId: number,
): Promise<Application | null> {
  const [row] = await db
    .select()
    .from(applicationsTable)
    .where(
      and(
        eq(applicationsTable.id, applicationId),
        eq(applicationsTable.userId, userId),
      ),
    )
    .limit(1);
  return row ?? null;
}

/** The application plus the posting it came from, for the interview brief pass. */
export async function getApplicationWithPosting(
  userId: string,
  applicationId: number,
) {
  const [row] = await db
    .select({
      application: applicationsTable,
      posting: postingsTable,
      fitAnalysis: userPostingsTable.fitAnalysis,
    })
    .from(applicationsTable)
    .innerJoin(postingsTable, eq(postingsTable.id, applicationsTable.jobId))
    .leftJoin(
      userPostingsTable,
      and(
        eq(userPostingsTable.postingId, postingsTable.id),
        eq(userPostingsTable.userId, userId),
      ),
    )
    .where(
      and(
        eq(applicationsTable.id, applicationId),
        eq(applicationsTable.userId, userId),
      ),
    )
    .limit(1);
  return row ?? null;
}

export type CreateApplicationInput = {
  postingId: number;
  resumeVersion: string;
  coverLetterVersion: string;
  notes: string;
};

export type CreateApplicationResult =
  | { ok: true; application: Application }
  | { ok: false; error: "posting-not-found" | "already-tracked" };

/**
 * Approving a posting in the review queue: creates the tracker row and
 * takes the posting out of the queue, in one transaction.
 *
 * The application starts as "approved", not "applied": approving only
 * prepares the tailored resume/cover letter and records the intent to
 * apply. Nothing is submitted to the employer here - the user must still
 * apply on the employer's site and confirm via PATCH /applications/:id.
 */
export async function createApplication(
  userId: string,
  input: CreateApplicationInput,
): Promise<CreateApplicationResult> {
  return db.transaction(async (tx) => {
    const [posting] = await tx
      .select({
        id: postingsTable.id,
        title: postingsTable.title,
        company: postingsTable.company,
        companyInitials: postingsTable.companyInitials,
        location: postingsTable.location,
      })
      .from(userPostingsTable)
      .innerJoin(postingsTable, eq(postingsTable.id, userPostingsTable.postingId))
      .where(
        and(
          eq(userPostingsTable.userId, userId),
          eq(userPostingsTable.postingId, input.postingId),
        ),
      )
      .limit(1);
    if (!posting) return { ok: false as const, error: "posting-not-found" as const };

    const [existing] = await tx
      .select({ id: applicationsTable.id })
      .from(applicationsTable)
      .where(
        and(
          eq(applicationsTable.userId, userId),
          eq(applicationsTable.jobId, input.postingId),
        ),
      )
      .limit(1);
    if (existing) return { ok: false as const, error: "already-tracked" as const };

    const [created] = await tx
      .insert(applicationsTable)
      .values({
        userId,
        jobId: posting.id,
        title: posting.title,
        company: posting.company,
        companyInitials: posting.companyInitials,
        location: posting.location,
        status: "approved",
        resumeVersion: input.resumeVersion,
        coverLetterVersion: input.coverLetterVersion,
        notes: input.notes,
      })
      .returning();
    if (!created) return { ok: false as const, error: "posting-not-found" as const };

    // The queue row itself flips to "applied" so it leaves the review queue
    // (GET /jobs filters on this status) - that is independent from the
    // application's own status above.
    await tx
      .update(userPostingsTable)
      .set({ status: "applied" })
      .where(
        and(
          eq(userPostingsTable.userId, userId),
          eq(userPostingsTable.postingId, input.postingId),
        ),
      );

    return { ok: true as const, application: created };
  });
}

export type ApplicationPatch = {
  status?: string;
  notes?: string;
  followUpDate?: string | null;
  interviewAt?: Date | null;
};

export async function updateApplication(
  userId: string,
  applicationId: number,
  patch: ApplicationPatch,
): Promise<Application | null> {
  const [row] = await db
    .update(applicationsTable)
    .set(patch)
    .where(
      and(
        eq(applicationsTable.id, applicationId),
        eq(applicationsTable.userId, userId),
      ),
    )
    .returning();
  return row ?? null;
}

/**
 * Records that the user themselves sent a follow-up for this application
 * (lot H4, lib/follow-ups.ts) - never called by anything that actually sends
 * mail, this is only the "I did this" confirmation, same honest-button
 * philosophy as the "I applied" flow above createApplication(). Bumps
 * `followUpCount` atomically so two rapid clicks cannot double-count.
 */
export async function markFollowedUp(
  userId: string,
  applicationId: number,
): Promise<Application | null> {
  const [row] = await db
    .update(applicationsTable)
    .set({
      lastFollowedUpAt: new Date(),
      followUpCount: sql`${applicationsTable.followUpCount} + 1`,
    })
    .where(
      and(
        eq(applicationsTable.id, applicationId),
        eq(applicationsTable.userId, userId),
      ),
    )
    .returning();
  return row ?? null;
}
