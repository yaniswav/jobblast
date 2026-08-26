// Per-account daily AI usage counters (docs/SAAS-ARCHITECTURE.md section 5,
// "Quotas" - v0.4 pre-beta lot). See lib/repo/postings.ts for why the
// `userId` parameter is not optional, and lib/quotas.ts for the pure math
// behind tryConsumeQuota().

import { and, eq, sql } from "drizzle-orm";
import { db, usageCountersTable } from "@workspace/db";
import { checkQuota, utcDayKey, type UsageKind } from "../quotas";

export type QuotaResult = { allowed: boolean; used: number; cap: number | null };

/**
 * Atomically bumps today's counter for (userId, kind) and reports whether
 * the account is still within `cap`. A null cap is unlimited and never even
 * touches the table.
 *
 * Checked BEFORE the provider call, never after: when the increment pushes
 * the count past the cap, it is rolled back immediately, so a rejected
 * attempt never costs the account part of tomorrow's quota.
 */
export async function tryConsumeQuota(
  userId: string,
  kind: UsageKind,
  cap: number | null,
  now: Date = new Date(),
): Promise<QuotaResult> {
  if (cap === null) return { allowed: true, used: 0, cap: null };

  const day = utcDayKey(now);
  const [row] = await db
    .insert(usageCountersTable)
    .values({ userId, day, kind, count: 1 })
    .onConflictDoUpdate({
      target: [usageCountersTable.userId, usageCountersTable.day, usageCountersTable.kind],
      set: { count: sql`${usageCountersTable.count} + 1` },
    })
    .returning({ count: usageCountersTable.count });

  const used = row?.count ?? 1;
  if (checkQuota(used, cap)) return { allowed: true, used, cap };

  await db
    .update(usageCountersTable)
    .set({ count: sql`greatest(${usageCountersTable.count} - 1, 0)` })
    .where(
      and(
        eq(usageCountersTable.userId, userId),
        eq(usageCountersTable.day, day),
        eq(usageCountersTable.kind, kind),
      ),
    );

  return { allowed: false, used: used - 1, cap };
}

/** Today's usage for one account, every kind - used by the account data export. */
export async function getUsageToday(
  userId: string,
  now: Date = new Date(),
): Promise<Record<UsageKind, number>> {
  const day = utcDayKey(now);
  const rows = await db
    .select({ kind: usageCountersTable.kind, count: usageCountersTable.count })
    .from(usageCountersTable)
    .where(and(eq(usageCountersTable.userId, userId), eq(usageCountersTable.day, day)));

  const result: Record<UsageKind, number> = { tailor: 0, fit: 0, brief: 0 };
  for (const row of rows) {
    if (row.kind === "tailor" || row.kind === "fit" || row.kind === "brief") {
      result[row.kind] = row.count;
    }
  }
  return result;
}
