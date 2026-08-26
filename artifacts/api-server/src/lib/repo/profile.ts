// The job seeker profile, one row per account.
// See lib/repo/postings.ts for why the `userId` parameter is not optional.

import { eq } from "drizzle-orm";
import { db, profilesTable, type Profile } from "@workspace/db";

export type { Profile } from "@workspace/db";

// Neutral placeholder profile inserted only when an account has no row yet.
// It is never used to overwrite an existing row: everything the app knows
// about the user lives in the DB and is edited from the Profile page / by
// uploading a CV, not in the codebase.
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

export async function getProfile(userId: string): Promise<Profile | null> {
  const [row] = await db
    .select()
    .from(profilesTable)
    .where(eq(profilesTable.userId, userId))
    .limit(1);
  return row ?? null;
}

/** Idempotent: gives a brand-new account something to edit. */
export async function ensureProfile(userId: string): Promise<Profile> {
  const existing = await getProfile(userId);
  if (existing) return existing;

  const [created] = await db
    .insert(profilesTable)
    .values({ userId, ...seedProfile })
    .onConflictDoNothing()
    .returning();
  if (created) return created;

  // Lost a race with a concurrent request: the row is there now.
  const row = await getProfile(userId);
  if (!row) throw new Error(`Could not seed a profile for user ${userId}`);
  return row;
}

export async function updateProfile(
  userId: string,
  patch: Partial<Omit<Profile, "id" | "userId">>,
): Promise<Profile | null> {
  const [row] = await db
    .update(profilesTable)
    .set(patch)
    .where(eq(profilesTable.userId, userId))
    .returning();
  return row ?? null;
}
