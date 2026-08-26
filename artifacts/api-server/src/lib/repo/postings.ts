// Every query against the shared posting pool and its per-account join.
//
// Layer 2 of the isolation model in docs/SAAS-ARCHITECTURE.md: ambient
// context is fine for read-only configuration, and not fine for database
// access, where a forgotten scope is a data leak. So every exported function
// here takes `userId` explicitly, first, and lib/scoping.test.ts fails the
// build if one of them stops doing that.

import { and, asc, desc, eq, gte, inArray, isNull, notExists, sql } from "drizzle-orm";
import {
  applicationsTable,
  db,
  postingsTable,
  userPostingsTable,
  type FitAnalysis,
  type InsertPosting,
} from "@workspace/db";

/**
 * One posting as the API and the AI passes see it: the shared advert
 * flattened together with this account's own score, status and AI output.
 * `id` is the posting id, which is what every route and the applications
 * table refer to.
 */
export type UserPostingRow = {
  id: number;
  source: string;
  title: string;
  company: string;
  companyInitials: string;
  location: string;
  workMode: string;
  url: string;
  description: string;
  postedDate: string;
  salaryRange: string;
  fetchedAt: Date;
  relevanceScore: number;
  matchReasons: string[];
  highlightedSkills: string[];
  tailoredBullets: string[];
  coverLetter: string;
  status: string;
  aiGenerated: boolean;
  fitAnalysis: FitAnalysis | null;
  applicationId: number | null;
};

const ROW_SELECTION = {
  id: postingsTable.id,
  source: postingsTable.source,
  title: postingsTable.title,
  company: postingsTable.company,
  companyInitials: postingsTable.companyInitials,
  location: postingsTable.location,
  workMode: postingsTable.workMode,
  url: postingsTable.url,
  description: postingsTable.description,
  postedDate: postingsTable.postedDate,
  salaryRange: postingsTable.salaryRange,
  fetchedAt: postingsTable.firstSeenAt,
  relevanceScore: userPostingsTable.relevanceScore,
  matchReasons: userPostingsTable.matchReasons,
  highlightedSkills: userPostingsTable.highlightedSkills,
  tailoredBullets: userPostingsTable.tailoredBullets,
  coverLetter: userPostingsTable.coverLetter,
  status: userPostingsTable.status,
  aiGenerated: userPostingsTable.aiGenerated,
  fitAnalysis: userPostingsTable.fitAnalysis,
  applicationId: applicationsTable.id,
};

function toRow(row: {
  [K in keyof typeof ROW_SELECTION]: unknown;
}): UserPostingRow {
  return { ...row, applicationId: row.applicationId ?? null } as UserPostingRow;
}

export async function listUserPostings(userId: string): Promise<UserPostingRow[]> {
  const rows = await db
    .select(ROW_SELECTION)
    .from(userPostingsTable)
    .innerJoin(postingsTable, eq(postingsTable.id, userPostingsTable.postingId))
    .leftJoin(
      applicationsTable,
      and(
        eq(applicationsTable.jobId, postingsTable.id),
        eq(applicationsTable.userId, userId),
      ),
    )
    .where(eq(userPostingsTable.userId, userId))
    .orderBy(desc(userPostingsTable.relevanceScore), asc(postingsTable.id));
  return rows.map(toRow);
}

export async function getUserPosting(
  userId: string,
  postingId: number,
): Promise<UserPostingRow | null> {
  const [row] = await db
    .select(ROW_SELECTION)
    .from(userPostingsTable)
    .innerJoin(postingsTable, eq(postingsTable.id, userPostingsTable.postingId))
    .leftJoin(
      applicationsTable,
      and(
        eq(applicationsTable.jobId, postingsTable.id),
        eq(applicationsTable.userId, userId),
      ),
    )
    .where(
      and(
        eq(userPostingsTable.userId, userId),
        eq(userPostingsTable.postingId, postingId),
      ),
    )
    .limit(1);
  return row ? toRow(row) : null;
}

/** Sets a queued posting to "skipped". False when the account has no such row. */
export async function skipUserPosting(
  userId: string,
  postingId: number,
): Promise<boolean> {
  const [row] = await db
    .update(userPostingsTable)
    .set({ status: "skipped" })
    .where(
      and(
        eq(userPostingsTable.userId, userId),
        eq(userPostingsTable.postingId, postingId),
      ),
    )
    .returning({ postingId: userPostingsTable.postingId });
  return row !== undefined;
}

/**
 * Whether this account has ever had a single posting attached, in any
 * status. Used by the dashboard (lib/dashboard-status.ts) to tell "nothing
 * has arrived yet" apart from "the queue is empty because everything in it
 * was reviewed or skipped" - `countUserQueue` alone cannot make that
 * distinction, since it only counts `status = 'queued'` rows.
 */
export async function hasAnyUserPostings(userId: string): Promise<boolean> {
  const [row] = await db
    .select({ one: sql<number>`1` })
    .from(userPostingsTable)
    .where(eq(userPostingsTable.userId, userId))
    .limit(1);
  return row !== undefined;
}

export type QueueCounts = { queued: number; strongMatches: number };

/** Dashboard funnel numbers, counted in SQL rather than by loading the queue. */
export async function countUserQueue(
  userId: string,
  strongMatchScore: number,
): Promise<QueueCounts> {
  const [row] = await db
    .select({
      queued: sql<number>`count(*) filter (where ${userPostingsTable.status} = 'queued')::int`,
      strongMatches: sql<number>`count(*) filter (where ${userPostingsTable.status} = 'queued' and ${userPostingsTable.relevanceScore} >= ${strongMatchScore})::int`,
    })
    .from(userPostingsTable)
    .where(eq(userPostingsTable.userId, userId));
  return { queued: row?.queued ?? 0, strongMatches: row?.strongMatches ?? 0 };
}

// ---------------------------------------------------------------------------
// Refresh pipeline
// ---------------------------------------------------------------------------

/** Posting ids this account already has a row for, among `urls`. */
export async function findPostingsByUrl(
  userId: string,
  urls: string[],
): Promise<Array<{ id: number; url: string; mine: boolean }>> {
  if (urls.length === 0) return [];
  const rows = await db
    .select({
      id: postingsTable.id,
      url: postingsTable.url,
      mine: userPostingsTable.userId,
    })
    .from(postingsTable)
    .leftJoin(
      userPostingsTable,
      and(
        eq(userPostingsTable.postingId, postingsTable.id),
        eq(userPostingsTable.userId, userId),
      ),
    )
    .where(inArray(postingsTable.url, urls));
  return rows.map((row) => ({ id: row.id, url: row.url, mine: row.mine !== null }));
}

/** The normalized title+company keys this account already has in its queue. */
export async function listUserTitleCompanyKeys(userId: string): Promise<string[]> {
  const rows = await db
    .select({ key: postingsTable.titleCompanyKey })
    .from(userPostingsTable)
    .innerJoin(postingsTable, eq(postingsTable.id, userPostingsTable.postingId))
    .where(eq(userPostingsTable.userId, userId));
  return rows.map((row) => row.key);
}

export type NewUserPosting = {
  posting: InsertPosting;
  relevanceScore: number;
  matchReasons: string[];
  highlightedSkills: string[];
  tailoredBullets: string[];
  coverLetter: string;
};

/**
 * Inserts the shared adverts (or adopts the ones another account already
 * fetched, refreshing `lastSeenAt`) and attaches them to this account's
 * queue. Returns how many queue rows were actually created.
 */
export async function addUserPostings(
  userId: string,
  entries: NewUserPosting[],
): Promise<number> {
  if (entries.length === 0) return 0;

  return db.transaction(async (tx) => {
    const postings = await tx
      .insert(postingsTable)
      .values(entries.map((entry) => entry.posting))
      .onConflictDoUpdate({
        target: postingsTable.url,
        set: { lastSeenAt: new Date() },
      })
      .returning({ id: postingsTable.id, url: postingsTable.url });

    const idByUrl = new Map(postings.map((row) => [row.url, row.id]));
    const queueRows = entries.flatMap((entry) => {
      const postingId = idByUrl.get(entry.posting.url);
      if (postingId === undefined) return [];
      return [
        {
          userId,
          postingId,
          relevanceScore: entry.relevanceScore,
          matchReasons: entry.matchReasons,
          highlightedSkills: entry.highlightedSkills,
          tailoredBullets: entry.tailoredBullets,
          coverLetter: entry.coverLetter,
        },
      ];
    });
    if (queueRows.length === 0) return 0;

    const inserted = await tx
      .insert(userPostingsTable)
      .values(queueRows)
      .onConflictDoNothing()
      .returning({ postingId: userPostingsTable.postingId });
    return inserted.length;
  });
}

// ---------------------------------------------------------------------------
// Shared refresh (saas): fetch once platform-wide, score per account
//
// The two halves of docs/SAAS-ARCHITECTURE.md section 3.2. The advert lands
// in the shared pool once, whoever asked for it; every account then scores
// what it has not seen yet against its own configuration.
// ---------------------------------------------------------------------------

/**
 * Writes adverts into the shared pool, refreshing `lastSeenAt` on the ones
 * already there. Platform-wide by nature: a posting belongs to no account,
 * which is why this is the one function here without a `userId`. It is named
 * in the PLATFORM_SCOPED allowlist of lib/scoping.test.ts, so adding another
 * one is a deliberate edit to that test rather than an oversight.
 */
export async function upsertPostings(postings: InsertPosting[]): Promise<number> {
  if (postings.length === 0) return 0;
  // De-dupe within the batch: `on conflict do update` cannot touch the same
  // row twice in one statement, and two boards mirroring one URL is normal.
  const byUrl = new Map(postings.map((posting) => [posting.url, posting]));
  const rows = await db
    .insert(postingsTable)
    .values(Array.from(byUrl.values()))
    .onConflictDoUpdate({ target: postingsTable.url, set: { lastSeenAt: new Date() } })
    .returning({ id: postingsTable.id });
  return rows.length;
}

/** A shared advert this account has not scored yet, in RawJob-compatible shape. */
export type PostingCandidate = {
  id: number;
  source: string;
  title: string;
  company: string;
  location: string;
  url: string;
  description: string;
  postedDate: string;
  salaryRange: string | null;
  titleCompanyKey: string;
};

/**
 * Adverts seen since `since` that this account has no queue row for yet.
 * The `not exists` is what makes the fan-out idempotent: re-running a
 * `user.score` job after a crash rescores nothing it already stored.
 */
export async function listPostingsToScore(
  userId: string,
  since: Date,
  limit: number,
): Promise<PostingCandidate[]> {
  const mine = db
    .select({ one: sql<number>`1` })
    .from(userPostingsTable)
    .where(
      and(
        eq(userPostingsTable.userId, userId),
        eq(userPostingsTable.postingId, postingsTable.id),
      ),
    );

  const rows = await db
    .select({
      id: postingsTable.id,
      source: postingsTable.source,
      title: postingsTable.title,
      company: postingsTable.company,
      location: postingsTable.location,
      url: postingsTable.url,
      description: postingsTable.description,
      postedDate: postingsTable.postedDate,
      salaryRange: postingsTable.salaryRange,
      titleCompanyKey: postingsTable.titleCompanyKey,
    })
    .from(postingsTable)
    .where(and(gte(postingsTable.lastSeenAt, since), notExists(mine)))
    .orderBy(desc(postingsTable.lastSeenAt))
    .limit(limit);
  return rows;
}

export type AttachedPosting = {
  postingId: number;
  relevanceScore: number;
  matchReasons: string[];
  highlightedSkills: string[];
  tailoredBullets: string[];
  coverLetter: string;
};

/** Attaches already-stored adverts to this account's queue. */
export async function attachUserPostings(
  userId: string,
  entries: AttachedPosting[],
): Promise<number> {
  if (entries.length === 0) return 0;
  const inserted = await db
    .insert(userPostingsTable)
    .values(entries.map((entry) => ({ userId, ...entry })))
    .onConflictDoNothing()
    .returning({ postingId: userPostingsTable.postingId });
  return inserted.length;
}

// ---------------------------------------------------------------------------
// AI passes
// ---------------------------------------------------------------------------

/** Queued postings whose letter is still the template, best matches first. */
export async function listUntailoredPostings(
  userId: string,
  limit: number,
): Promise<UserPostingRow[]> {
  const rows = await db
    .select(ROW_SELECTION)
    .from(userPostingsTable)
    .innerJoin(postingsTable, eq(postingsTable.id, userPostingsTable.postingId))
    .leftJoin(
      applicationsTable,
      and(
        eq(applicationsTable.jobId, postingsTable.id),
        eq(applicationsTable.userId, userId),
      ),
    )
    .where(
      and(
        eq(userPostingsTable.userId, userId),
        eq(userPostingsTable.status, "queued"),
        eq(userPostingsTable.aiGenerated, false),
      ),
    )
    .orderBy(desc(userPostingsTable.relevanceScore))
    .limit(limit);
  return rows.map(toRow);
}

/** Queued postings with no fit verdict yet, best matches first. */
export async function listUnanalyzedPostings(
  userId: string,
  limit: number,
): Promise<UserPostingRow[]> {
  const rows = await db
    .select(ROW_SELECTION)
    .from(userPostingsTable)
    .innerJoin(postingsTable, eq(postingsTable.id, userPostingsTable.postingId))
    .leftJoin(
      applicationsTable,
      and(
        eq(applicationsTable.jobId, postingsTable.id),
        eq(applicationsTable.userId, userId),
      ),
    )
    .where(
      and(
        eq(userPostingsTable.userId, userId),
        eq(userPostingsTable.status, "queued"),
        isNull(userPostingsTable.fitAnalysis),
      ),
    )
    .orderBy(desc(userPostingsTable.relevanceScore))
    .limit(limit);
  return rows.map(toRow);
}

export async function saveTailoredContent(
  userId: string,
  postingId: number,
  content: { bullets: string[]; coverLetter: string },
): Promise<void> {
  await db
    .update(userPostingsTable)
    .set({
      tailoredBullets: content.bullets,
      coverLetter: content.coverLetter,
      aiGenerated: true,
    })
    .where(
      and(
        eq(userPostingsTable.userId, userId),
        eq(userPostingsTable.postingId, postingId),
      ),
    );
}

export async function saveFitAnalysis(
  userId: string,
  postingId: number,
  analysis: FitAnalysis,
): Promise<void> {
  await db
    .update(userPostingsTable)
    .set({ fitAnalysis: analysis, fitAnalyzedAt: new Date() })
    .where(
      and(
        eq(userPostingsTable.userId, userId),
        eq(userPostingsTable.postingId, postingId),
      ),
    );
}
