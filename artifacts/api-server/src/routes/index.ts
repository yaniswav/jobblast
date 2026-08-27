import { Router, type IRouter } from "express";
import { requireUser } from "../lib/auth/middleware";
import healthRouter from "./health";
import authRouter from "./auth";
import onboardingRouter from "./onboarding";
import dashboardRouter from "./dashboard";
import statsRouter from "./stats";
import jobsRouter from "./jobs";
import exploreRouter from "./explore";
import applicationsRouter from "./applications";
import profileRouter from "./profile";
import resumesRouter from "./resumes";
import documentsRouter from "./documents";
import settingsRouter from "./settings";
import accountRouter from "./account";
import legalRouter from "./legal";
import trialRouter from "./trial";

const router: IRouter = Router();

// Applied once, here, rather than per route: a route added later is behind
// auth by default. The public paths (/healthz, /legal and the /auth/*
// endpoints) are an explicit allowlist inside requireUser.
router.use(requireUser);

router.use(healthRouter);
router.use(authRouter);
router.use(onboardingRouter);
router.use(dashboardRouter);
router.use(statsRouter);
router.use(jobsRouter);
router.use(exploreRouter);
router.use(applicationsRouter);
router.use(profileRouter);
router.use(resumesRouter);
router.use(documentsRouter);
router.use(settingsRouter);
router.use(accountRouter);
router.use(legalRouter);
router.use(trialRouter);

export default router;
