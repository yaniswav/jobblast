import { Router, type IRouter } from "express";
import { GetDashboardResponse } from "@workspace/api-zod";
import { actingUserId } from "../lib/auth/middleware";
import { listApplications } from "../lib/repo/applications";
import { countUserQueue } from "../lib/repo/postings";
import { ensureProfile } from "../lib/repo/profile";

const router: IRouter = Router();

/** Relevance at or above this counts as a strong match on the dashboard. */
const STRONG_MATCH_SCORE = 85;

router.get("/dashboard", async (req, res): Promise<void> => {
  const userId = actingUserId(req);
  await ensureProfile(userId);
  const applications = await listApplications(userId);
  const queue = await countUserQueue(userId, STRONG_MATCH_SCORE);
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
  const needsFollowUp = applications.filter(
    (application) =>
      application.followUpDate != null &&
      new Date(`${application.followUpDate}T23:59:59`) <= today &&
      !["interview", "offer", "rejected"].includes(application.status),
  ).length;

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
    recentApplications: applications.slice(0, 4),
  });
  res.json(data);
});

export default router;
