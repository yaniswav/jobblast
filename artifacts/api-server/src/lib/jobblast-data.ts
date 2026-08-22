import { and, asc, desc, eq, inArray, notInArray } from "drizzle-orm";
import {
  applicationsTable,
  db,
  jobListingsTable,
  profilesTable,
} from "@workspace/db";

// Neutral placeholder profile inserted only when the `profiles` table is
// empty (a brand-new database). It is never used to overwrite an existing
// row: everything the app knows about the user lives in the DB and is edited
// from the Profile page / by uploading a CV, not in the codebase.
const seedProfile = {
  name: "Your Name",
  email: "you@example.com",
  headline: "Add a one-line headline describing the roles you are targeting",
  targetRoles: [] as string[],
  targetLocations: [] as string[],
  salaryFloor: 0,
  excludedCompanies: [] as string[],
  masterResume:
    "Paste your master resume here (or upload your CV PDF in Documents - the text is extracted into this field automatically).",
};

let seedCleanupDone = false;

/**
 * One-time-per-process cleanup of the bootstrap `isSeed=true` job listings.
 * These used to be inserted with fake inflated relevance scores just to give
 * the review queue something to show before real aggregation
 * (lib/sources/refresh.ts) ran; they're no longer inserted at all (see
 * ensureJobBlastSeeded below), so any that still exist are leftovers from
 * before this change.
 *
 * - Seed rows referenced by an application are kept (tracker integrity) but
 *   defensively forced to status "applied" so they can never reappear in the
 *   review queue.
 * - Seed rows with no application are deleted outright.
 *
 * Guarded by a module-level flag so it only runs once per server process
 * (mirrors the passRunning guard in lib/ai/tailor.ts), not on every request.
 */
async function cleanupOrphanSeedJobs(): Promise<void> {
  if (seedCleanupDone) return;
  seedCleanupDone = true;

  const referencedSeedJobs = await db
    .selectDistinct({ id: jobListingsTable.id })
    .from(jobListingsTable)
    .innerJoin(applicationsTable, eq(applicationsTable.jobId, jobListingsTable.id))
    .where(eq(jobListingsTable.isSeed, true));
  const referencedIds = referencedSeedJobs.map((row) => row.id);

  if (referencedIds.length > 0) {
    await db
      .update(jobListingsTable)
      .set({ status: "applied" })
      .where(and(eq(jobListingsTable.isSeed, true), inArray(jobListingsTable.id, referencedIds)));

    await db
      .delete(jobListingsTable)
      .where(and(eq(jobListingsTable.isSeed, true), notInArray(jobListingsTable.id, referencedIds)));
  } else {
    await db.delete(jobListingsTable).where(eq(jobListingsTable.isSeed, true));
  }
}

export async function ensureJobBlastSeeded(): Promise<void> {
  const [existingProfile] = await db.select().from(profilesTable).limit(1);
  if (!existingProfile) {
    await db.insert(profilesTable).values(seedProfile);
  }

  await cleanupOrphanSeedJobs();
}

export async function getJobWithApplication(id: number) {
  const rows = await db
    .select({
      job: jobListingsTable,
      applicationId: applicationsTable.id,
    })
    .from(jobListingsTable)
    .leftJoin(applicationsTable, eq(applicationsTable.jobId, jobListingsTable.id))
    .where(eq(jobListingsTable.id, id))
    .limit(1);

  const row = rows[0];
  if (!row) return null;
  return { ...row.job, applicationId: row.applicationId ?? null };
}

export async function listJobsWithApplications() {
  const rows = await db
    .select({
      job: jobListingsTable,
      applicationId: applicationsTable.id,
    })
    .from(jobListingsTable)
    .leftJoin(applicationsTable, eq(applicationsTable.jobId, jobListingsTable.id))
    .orderBy(desc(jobListingsTable.relevanceScore), asc(jobListingsTable.id));

  return rows.map((row) => ({ ...row.job, applicationId: row.applicationId ?? null }));
}

export async function getApplications() {
  return db.select().from(applicationsTable).orderBy(desc(applicationsTable.appliedAt));
}
