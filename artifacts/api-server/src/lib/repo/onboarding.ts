// Onboarding state for one account (G1 lot). See lib/onboarding.ts for the
// pure decision logic this feeds.

import { eq } from "drizzle-orm";
import { db, userSettingsTable, usersTable } from "@workspace/db";

export async function isOnboardingComplete(userId: string): Promise<boolean> {
  const [row] = await db
    .select({ at: usersTable.onboardingCompletedAt })
    .from(usersTable)
    .where(eq(usersTable.id, userId))
    .limit(1);
  return row?.at != null;
}

/** Marks the account onboarded. Idempotent - a repeat call just moves the timestamp forward. */
export async function markOnboardingComplete(userId: string): Promise<void> {
  await db
    .update(usersTable)
    .set({ onboardingCompletedAt: new Date() })
    .where(eq(usersTable.id, userId));
}

/**
 * Whether the account has explicitly saved search criteria (keywords or
 * target locations), reading the RAW stored jsonb rather than the
 * Zod-defaulted config `loadConfig()`/`configFor()` return.
 *
 * This distinction matters: `JobBlastConfigSchema`'s defaults for
 * `sources.franceTravail.keywords` are the *owner's own* example keywords
 * (see lib/config.ts's DEFAULT_SCORING_RULES-adjacent source defaults), not
 * an empty list - so a fresh account that has never touched Settings would
 * look "already configured" if this read through the merged config instead
 * of the row actually stored for it.
 */
export async function hasStoredSearchCriteria(userId: string): Promise<boolean> {
  const [row] = await db
    .select({ config: userSettingsTable.config })
    .from(userSettingsTable)
    .where(eq(userSettingsTable.userId, userId))
    .limit(1);
  if (!row) return false;

  const config = row.config as Record<string, unknown>;
  const sources = config["sources"] as Record<string, unknown> | undefined;
  const franceTravail = sources?.["franceTravail"] as Record<string, unknown> | undefined;
  const keywords = franceTravail?.["keywords"];
  const scoring = config["scoring"] as Record<string, unknown> | undefined;
  const targetLocationKeywords = scoring?.["targetLocationKeywords"];

  const hasKeywords = Array.isArray(keywords) && keywords.length > 0;
  const hasLocations = Array.isArray(targetLocationKeywords) && targetLocationKeywords.length > 0;
  return hasKeywords || hasLocations;
}
