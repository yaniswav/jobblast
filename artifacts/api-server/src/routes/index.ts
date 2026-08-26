import { Router, type IRouter } from "express";
import healthRouter from "./health";
import dashboardRouter from "./dashboard";
import jobsRouter from "./jobs";
import applicationsRouter from "./applications";
import profileRouter from "./profile";
import documentsRouter from "./documents";
import settingsRouter from "./settings";

const router: IRouter = Router();

router.use(healthRouter);
router.use(dashboardRouter);
router.use(jobsRouter);
router.use(applicationsRouter);
router.use(profileRouter);
router.use(documentsRouter);
router.use(settingsRouter);

export default router;
