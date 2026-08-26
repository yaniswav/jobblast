// Interview prep brief rows, scoped by account.
// See lib/repo/postings.ts for why the `userId` parameter is not optional.

import { and, asc, eq } from "drizzle-orm";
import { db, interviewBriefsTable, type InterviewBrief } from "@workspace/db";

export type { InterviewBrief } from "@workspace/db";

export async function getBrief(
  userId: string,
  applicationId: number,
): Promise<InterviewBrief | null> {
  const [row] = await db
    .select()
    .from(interviewBriefsTable)
    .where(
      and(
        eq(interviewBriefsTable.userId, userId),
        eq(interviewBriefsTable.applicationId, applicationId),
      ),
    )
    .limit(1);
  return row ?? null;
}

/** Reads a brief only if it is ready to be rendered (used by the PDF route). */
export async function getReadyBrief(
  userId: string,
  applicationId: number,
): Promise<InterviewBrief | null> {
  const [row] = await db
    .select()
    .from(interviewBriefsTable)
    .where(
      and(
        eq(interviewBriefsTable.userId, userId),
        eq(interviewBriefsTable.applicationId, applicationId),
        eq(interviewBriefsTable.status, "ready"),
      ),
    )
    .limit(1);
  return row ?? null;
}

/** Inserts a "pending" row if there isn't one. True when it queued something. */
export async function queueBrief(
  userId: string,
  applicationId: number,
): Promise<boolean> {
  const existing = await getBrief(userId, applicationId);
  if (existing) return false;
  const inserted = await db
    .insert(interviewBriefsTable)
    .values({ userId, applicationId, status: "pending" })
    .onConflictDoNothing()
    .returning({ id: interviewBriefsTable.id });
  return inserted.length > 0;
}

/** Resets a brief back to "pending", clearing whatever was there. */
export async function resetBrief(
  userId: string,
  applicationId: number,
): Promise<boolean> {
  const [row] = await db
    .update(interviewBriefsTable)
    .set({ status: "pending", contentMarkdown: null, generatedAt: null, error: null })
    .where(
      and(
        eq(interviewBriefsTable.userId, userId),
        eq(interviewBriefsTable.applicationId, applicationId),
      ),
    )
    .returning({ id: interviewBriefsTable.id });
  return row !== undefined;
}

/** Every brief this account has, in any status - used by the account data export. */
export async function listBriefs(userId: string): Promise<InterviewBrief[]> {
  return db
    .select()
    .from(interviewBriefsTable)
    .where(eq(interviewBriefsTable.userId, userId))
    .orderBy(asc(interviewBriefsTable.createdAt));
}

export async function listPendingBriefs(
  userId: string,
  limit: number,
): Promise<number[]> {
  const rows = await db
    .select({ applicationId: interviewBriefsTable.applicationId })
    .from(interviewBriefsTable)
    .where(
      and(
        eq(interviewBriefsTable.userId, userId),
        eq(interviewBriefsTable.status, "pending"),
      ),
    )
    .orderBy(asc(interviewBriefsTable.createdAt))
    .limit(limit);
  return rows.map((row) => row.applicationId);
}

/**
 * Crash recovery: anything still "generating" belongs to a process that died
 * mid-run and would otherwise be stuck forever. Returns how many were freed.
 */
export async function reclaimStuckBriefs(userId: string): Promise<number> {
  const rows = await db
    .update(interviewBriefsTable)
    .set({ status: "pending" })
    .where(
      and(
        eq(interviewBriefsTable.userId, userId),
        eq(interviewBriefsTable.status, "generating"),
      ),
    )
    .returning({ id: interviewBriefsTable.id });
  return rows.length;
}

export type BriefPatch = {
  status?: string;
  contentMarkdown?: string | null;
  generatedAt?: Date | null;
  error?: string | null;
};

export async function updateBrief(
  userId: string,
  applicationId: number,
  patch: BriefPatch,
): Promise<void> {
  await db
    .update(interviewBriefsTable)
    .set(patch)
    .where(
      and(
        eq(interviewBriefsTable.userId, userId),
        eq(interviewBriefsTable.applicationId, applicationId),
      ),
    );
}
