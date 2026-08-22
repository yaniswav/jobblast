import { Router, type IRouter } from "express";
import { and, eq, gte, isNotNull, lt, sql } from "drizzle-orm";
import { db, applicationsTable, jobListingsTable } from "@workspace/db";
import { GetDashboardResponse } from "@workspace/api-zod";
import { ensureJobBlastSeeded, getApplications } from "../lib/jobblast-data";

const router: IRouter = Router();

router.get("/dashboard", async (_req, res): Promise<void> => {
  await ensureJobBlastSeeded();
  const applications = await getApplications();
  const jobs = await db.select().from(jobListingsTable);
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
    queuedCount: jobs.filter((job) => job.status === "queued").length,
    strongMatchCount: jobs.filter((job) => job.status === "queued" && job.relevanceScore >= 85).length,
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