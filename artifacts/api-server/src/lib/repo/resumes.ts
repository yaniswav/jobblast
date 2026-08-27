// Every query against an account's master resumes (lot I3: multiple master
// resumes per account, e.g. "Stage FR" / "CDI EN"). See lib/repo/postings.ts
// for why `userId` is always the first parameter.
//
// `profiles.masterResume` (schema/profiles.ts) is kept mirroring whichever
// resume is currently `isDefault`, both directions:
//   - writing here (create-as-default, update the default's content,
//     set-default, delete the default) pushes the new content into
//     `profiles.masterResume` (mirrorMasterResume below).
//   - writing `profiles.masterResume` (lib/repo/profile.ts's updateProfile,
//     which onboarding's "paste your resume" step and the CV-PDF-upload
//     flow both still call) pushes back in here via
//     syncDefaultResumeFromProfile.
// That invariant is what keeps every pre-I3 reader of `profiles.masterResume`
// working unmodified, and is also why an account with a single resume is
// byte-identical to before this lot.

import { and, asc, eq } from "drizzle-orm";
import { db, profilesTable, resumesTable, type Resume } from "@workspace/db";
import { selectResumeForJob, type ResumeSelectionJob } from "../resume-select";

export type { Resume } from "@workspace/db";

/** Hard cap on resumes per account, enforced by validateCreateResume below. */
export const RESUME_CAP = 5;

/** i18n-neutral label the one-time backfill (scripts/src/backfill-resumes.ts) and a brand-new account's first resume both use. */
export const DEFAULT_RESUME_LABEL = "Main";

// ---------------------------------------------------------------------------
// Pure validation - no database. Covered directly by resumes.test.ts.
// ---------------------------------------------------------------------------

export type CreateResumeValidation = { ok: true } | { ok: false; error: "cap-reached" };

/** Whether a new resume may be created, given how many the account already has. */
export function validateCreateResume(existingCount: number): CreateResumeValidation {
  return existingCount >= RESUME_CAP ? { ok: false, error: "cap-reached" } : { ok: true };
}

export type DeleteResumeValidation = { ok: true } | { ok: false; error: "last-resume" };

/** Whether a resume may be deleted, given how many the account already has (deleting the only one is refused). */
export function validateDeleteResume(existingCount: number): DeleteResumeValidation {
  return existingCount <= 1 ? { ok: false, error: "last-resume" } : { ok: true };
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

async function listStoredResumes(userId: string): Promise<Resume[]> {
  return db
    .select()
    .from(resumesTable)
    .where(eq(resumesTable.userId, userId))
    .orderBy(asc(resumesTable.id));
}

/**
 * Every resume this account has, oldest first. Falls back to a single
 * synthetic "Main" resume built from `profiles.masterResume` when the table
 * has no rows yet - a pre-onboarding account, or one whose one-time backfill
 * found nothing real to seed. Never persisted: nothing is written by reading.
 * The synthetic row's `id` is never a real resumes.id (the serial sequence
 * starts at 1), so callers must treat it as read-only.
 */
export async function listResumes(userId: string): Promise<Resume[]> {
  const stored = await listStoredResumes(userId);
  if (stored.length > 0) return stored;

  const [profile] = await db
    .select({ masterResume: profilesTable.masterResume })
    .from(profilesTable)
    .where(eq(profilesTable.userId, userId))
    .limit(1);
  if (!profile) return [];

  const now = new Date();
  return [
    {
      id: 0,
      userId,
      label: DEFAULT_RESUME_LABEL,
      content: profile.masterResume,
      isDefault: true,
      createdAt: now,
      updatedAt: now,
    },
  ];
}

/** The resume selected for `job` (title + description), out of every resume this account has. Null only for an account with no profile at all. */
export async function selectResumeForPosting(
  userId: string,
  job: ResumeSelectionJob,
): Promise<Resume | null> {
  const resumes = await listResumes(userId);
  if (resumes.length === 0) return null;
  return selectResumeForJob(resumes, job);
}

// ---------------------------------------------------------------------------
// Writes
//
// Every write below that changes what the default resume's content IS also
// mirrors that content into `profiles.masterResume` in the same transaction
// (inline, rather than through a shared helper - a generic-in-generic tx
// type from drizzle's `db.transaction` callback is more trouble than the
// one-line `tx.update(profilesTable)...` it would save four times over).
// ---------------------------------------------------------------------------

export type CreateResumeInput = { label: string; content: string };
export type CreateResumeResult = { ok: true; resume: Resume } | { ok: false; error: "cap-reached" };

/** Creates a resume. The account's very first resume is always the default; later ones start as non-default. */
export async function createResume(
  userId: string,
  input: CreateResumeInput,
): Promise<CreateResumeResult> {
  return db.transaction(async (tx) => {
    const existing = await tx
      .select({ id: resumesTable.id })
      .from(resumesTable)
      .where(eq(resumesTable.userId, userId));

    const validation = validateCreateResume(existing.length);
    if (!validation.ok) return { ok: false as const, error: validation.error };

    const isFirst = existing.length === 0;
    const [created] = await tx
      .insert(resumesTable)
      .values({ userId, label: input.label, content: input.content, isDefault: isFirst })
      .returning();
    if (!created) throw new Error("Could not create resume");

    if (isFirst) {
      await tx.update(profilesTable).set({ masterResume: created.content }).where(eq(profilesTable.userId, userId));
    }
    return { ok: true as const, resume: created };
  });
}

export type UpdateResumeInput = Partial<{ label: string; content: string }>;

/** Updates a resume's label and/or content. Null when no such resume exists for this account. */
export async function updateResume(
  userId: string,
  id: number,
  patch: UpdateResumeInput,
): Promise<Resume | null> {
  return db.transaction(async (tx) => {
    const [updated] = await tx
      .update(resumesTable)
      .set({ ...patch, updatedAt: new Date() })
      .where(and(eq(resumesTable.id, id), eq(resumesTable.userId, userId)))
      .returning();
    if (!updated) return null;

    if (updated.isDefault && patch.content !== undefined) {
      await tx.update(profilesTable).set({ masterResume: updated.content }).where(eq(profilesTable.userId, userId));
    }
    return updated;
  });
}

export type SetDefaultResumeResult = { ok: true; resume: Resume } | { ok: false; error: "not-found" };

/** Makes resume `id` the account's default, clearing the previous default. */
export async function setDefaultResume(
  userId: string,
  id: number,
): Promise<SetDefaultResumeResult> {
  return db.transaction(async (tx) => {
    const [target] = await tx
      .select({ id: resumesTable.id })
      .from(resumesTable)
      .where(and(eq(resumesTable.id, id), eq(resumesTable.userId, userId)))
      .limit(1);
    if (!target) return { ok: false as const, error: "not-found" as const };

    await tx
      .update(resumesTable)
      .set({ isDefault: false })
      .where(and(eq(resumesTable.userId, userId), eq(resumesTable.isDefault, true)));

    const [updated] = await tx
      .update(resumesTable)
      .set({ isDefault: true, updatedAt: new Date() })
      .where(eq(resumesTable.id, id))
      .returning();
    if (!updated) throw new Error("Could not set default resume");

    await tx.update(profilesTable).set({ masterResume: updated.content }).where(eq(profilesTable.userId, userId));
    return { ok: true as const, resume: updated };
  });
}

export type DeleteResumeResult = { ok: true } | { ok: false; error: "not-found" | "last-resume" };

/** Deletes a resume. Refuses to delete an account's last remaining resume. Reassigns the default when the deleted resume was it. */
export async function deleteResume(userId: string, id: number): Promise<DeleteResumeResult> {
  return db.transaction(async (tx) => {
    const all = await tx
      .select()
      .from(resumesTable)
      .where(eq(resumesTable.userId, userId))
      .orderBy(asc(resumesTable.id));
    const target = all.find((resume) => resume.id === id);
    if (!target) return { ok: false as const, error: "not-found" as const };

    const validation = validateDeleteResume(all.length);
    if (!validation.ok) return { ok: false as const, error: validation.error };

    await tx.delete(resumesTable).where(and(eq(resumesTable.id, id), eq(resumesTable.userId, userId)));

    if (target.isDefault) {
      const nextDefault = all.find((resume) => resume.id !== id)!;
      const [updated] = await tx
        .update(resumesTable)
        .set({ isDefault: true, updatedAt: new Date() })
        .where(eq(resumesTable.id, nextDefault.id))
        .returning();
      if (updated) {
        await tx
          .update(profilesTable)
          .set({ masterResume: updated.content })
          .where(eq(profilesTable.userId, userId));
      }
    }

    return { ok: true as const };
  });
}

/**
 * Called from lib/repo/profile.ts's updateProfile whenever `masterResume` is
 * part of the patch (onboarding's "paste your resume" step, and the CV-PDF
 * upload flow in routes/documents.ts). Creates the account's first resume
 * (labeled "Main", default) when the table is still empty - exactly what
 * turns onboarding's unmodified UI into this lot's multi-CV data model -
 * otherwise updates the current default resume's content in place.
 */
export async function syncDefaultResumeFromProfile(
  userId: string,
  masterResume: string,
): Promise<void> {
  await db.transaction(async (tx) => {
    const existing = await tx
      .select()
      .from(resumesTable)
      .where(eq(resumesTable.userId, userId))
      .orderBy(asc(resumesTable.id));

    if (existing.length === 0) {
      await tx.insert(resumesTable).values({
        userId,
        label: DEFAULT_RESUME_LABEL,
        content: masterResume,
        isDefault: true,
      });
      return;
    }

    const current = existing.find((resume) => resume.isDefault) ?? existing[0]!;
    await tx
      .update(resumesTable)
      .set({ content: masterResume, updatedAt: new Date() })
      .where(eq(resumesTable.id, current.id));
  });
}
