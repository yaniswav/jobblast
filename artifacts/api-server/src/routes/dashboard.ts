import { Router, type IRouter } from "express";
import { GetDashboardResponse } from "@workspace/api-zod";
import { actingUserId } from "../lib/auth/middleware";
import { getUserById } from "../lib/auth/store";
import { loadConfig } from "../lib/config";
import { isFirstBatchPending } from "../lib/dashboard-status";
import { selectFollowUpCandidates, withFollowUpEligibility } from "../lib/follow-ups";
import { IS_SAAS } from "../lib/mode";
import { listApplications } from "../lib/repo/applications";
import { countUserQueue, hasAnyUserPostings } from "../lib/repo/postings";
import { ensureProfile } from "../lib/repo/profile";

const router: IRouter = Router();

/** Relevance at or above this counts as a strong match on the dashboard. */
const STRONG_MATCH_SCORE = 85;

router.get("/dashboard", async (req, res): Promise<void> => {
  const userId = actingUserId(req);
  await ensureProfile(userId);
  const applications = await listApplications(userId);
  const queue = await countUserQueue(userId, STRONG_MATCH_SCORE);

  // saas only (G1 onboarding lot): whether to explain an empty queue as
  // "your first batch is still on its way" rather than showing it silently.
  // Gated on IS_SAAS, not just the underlying signals, so a fresh self-hosted
  // install's dashboard is unaffected during the few minutes before its own
  // first refresh completes - see lib/dashboard-status.ts.
  let firstBatchPending = false;
  if (IS_SAAS) {
    const [hasAnyPostings, user] = await Promise.all([hasAnyUserPostings(userId), getUserById(userId)]);
    firstBatchPending = isFirstBatchPending({
      hasAnyPostings,
      accountCreatedAt: user?.createdAt ?? new Date(0),
      now: new Date(),
    });
  }

  const today = new Date();
  const todayStart = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  // "approved" rows are prepared applications the user hasn't actually sent
  // yet (see routes/applications.ts) — they must not count as "applied" in
  // any of the funnel stats below, or the dashboard would mislead the user
  // the same way the old auto-"applied" status used to.
  const sentApplications = applications.filter((application) => application.status !== "approved");
  const appliedToday = sentApplications.filter((application) => application.appliedAt >= todayStart).length;
  const responses = applications.filter((application) =>
    ["responded", "interview", "offer", "rejected"].includes(application.status),
  ).length;
  // The real "needs a follow-up" logic (lot H4, lib/follow-ups.ts): still
  // "applied" with no reply, past the account's follow-up delay
  // (followUps.afterDays), under the suggestion cap. This replaced an older
  // heuristic keyed on the manual `followUpDate` reminder field, which is a
  // separate, user-set "come back to this" date and stays available in the
  // tracker's own Follow-up column - it just no longer drives this count.
  const { afterDays } = loadConfig().followUps;
  const needsFollowUp = selectFollowUpCandidates(applications, today, afterDays).length;

  const data = GetDashboardResponse.parse({
    dailyGoal: 50,
    appliedToday,
    queuedCount: queue.queued,
    strongMatchCount: queue.strongMatches,
    responseRate: sentApplications.length ? Math.round((responses / sentApplications.length) * 100) : 0,
    interviewCount: applications.filter((application) => application.status === "interview").length,
    offerCount: applications.filter((application) => application.status === "offer").length,
    needsFollowUp,
    streakDays: 4,
    recentApplications: applications.slice(0, 4).map((application) => withFollowUpEligibility(application, today, afterDays)),
    firstBatchPending,
  });
  res.json(data);
});

export default router;
