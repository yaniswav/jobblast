// Campaign performance stats (lot I4): funnel, response rate by source and
// by resume, weekly trend and average first-response delay. Every number
// comes from applications, their timeline events and the postings they
// came from - no new table. See lib/stats.ts for the pure aggregation logic
// and lib/repo/stats.ts for the two queries feeding it.

import { Router, type IRouter } from "express";
import { GetCampaignStatsResponse } from "@workspace/api-zod";
import { actingUserId } from "../lib/auth/middleware";
import { ensureProfile } from "../lib/repo/profile";
import { listApplicationsForStats, listEventsForStats } from "../lib/repo/stats";
import { computeCampaignStats } from "../lib/stats";

const router: IRouter = Router();

router.get("/stats", async (req, res): Promise<void> => {
  const userId = actingUserId(req);
  await ensureProfile(userId);
  const [applications, events] = await Promise.all([
    listApplicationsForStats(userId),
    listEventsForStats(userId),
  ]);
  const stats = computeCampaignStats(applications, events, new Date());
  res.json(GetCampaignStatsResponse.parse(stats));
});

export default router;
