// The G1 onboarding wizard's two endpoints (saas only): where to resume, and
// marking it done. See docs/SAAS-ARCHITECTURE.md and lib/onboarding.ts for
// why detection is an explicit flag rather than a heuristic, and why the
// resume step is deduced from real profile/settings data instead.

import { Router, type IRouter, type Response } from "express";
import { CompleteOnboardingResponse, GetOnboardingStatusResponse } from "@workspace/api-zod";
import { actingUserId } from "../lib/auth/middleware";
import { IS_SAAS } from "../lib/mode";
import { resumeOnboardingStep } from "../lib/onboarding";
import { enqueueRefreshForUser } from "../lib/queue/handlers";
import { hasStoredSearchCriteria, isOnboardingComplete, markOnboardingComplete } from "../lib/repo/onboarding";
import { ensureProfile, hasRealResume } from "../lib/repo/profile";

const router: IRouter = Router();

function requireSaas(res: Response): boolean {
  if (IS_SAAS) return true;
  res.status(404).json({ error: "Onboarding does not exist on a self-hosted install" });
  return false;
}

router.get("/onboarding/status", async (req, res): Promise<void> => {
  if (!requireSaas(res)) return;
  const userId = actingUserId(req);

  if (await isOnboardingComplete(userId)) {
    res.json(GetOnboardingStatusResponse.parse({ completed: true, nextStep: null }));
    return;
  }

  const profile = await ensureProfile(userId);
  const hasCriteria = await hasStoredSearchCriteria(userId);
  const nextStep = resumeOnboardingStep({ hasResume: hasRealResume(profile), hasCriteria });
  res.json(GetOnboardingStatusResponse.parse({ completed: false, nextStep }));
});

router.post("/onboarding/complete", async (req, res): Promise<void> => {
  if (!requireSaas(res)) return;
  const userId = actingUserId(req);

  await ensureProfile(userId);
  await markOnboardingComplete(userId);

  // Enqueues the fetches this account is waiting on plus its own scoring
  // pass, via the existing queue (same path as "Refresh now" in
  // routes/jobs.ts) - never a fetch inline in this request. The actual work
  // happens in the background worker.
  await enqueueRefreshForUser(userId);

  res.json(CompleteOnboardingResponse.parse({ completed: true }));
});

export default router;
