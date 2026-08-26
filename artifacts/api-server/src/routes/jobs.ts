import { Router, type IRouter } from "express";
import {
  GetJobCoverLetterPdfParams,
  GetJobParams,
  GetJobResponse,
  ListJobsQueryParams,
  ListJobsResponse,
  RefreshJobsResponse,
  SkipJobParams,
} from "@workspace/api-zod";
import { runFitAnalysisPass } from "../lib/ai/fit-analysis";
import { runTailoringPass } from "../lib/ai/tailor";
import { actingUserId } from "../lib/auth/middleware";
import { logger } from "../lib/logger";
import { renderCoverLetterPdf, sanitizeFilenameSegment } from "../lib/pdf-cover-letter";
import {
  getUserPosting,
  listUserPostings,
  skipUserPosting,
} from "../lib/repo/postings";
import { ensureProfile } from "../lib/repo/profile";
import { isRefreshRunning, refreshJobListings } from "../lib/sources/refresh";

const router: IRouter = Router();

router.get("/jobs", async (req, res): Promise<void> => {
  const userId = actingUserId(req);
  await ensureProfile(userId);
  const query = ListJobsQueryParams.safeParse(req.query);
  if (!query.success) {
    res.status(400).json({ error: query.error.message });
    return;
  }
  const jobs = await listUserPostings(userId);
  const search = query.data.search?.toLowerCase().trim();
  const filtered = jobs.filter((job) => {
    const matchesSearch =
      !search ||
      [job.title, job.company, job.location, job.description]
        .join(" ")
        .toLowerCase()
        .includes(search);
    return matchesSearch && (!query.data.status || job.status === query.data.status);
  });
  res.json(ListJobsResponse.parse(filtered));
});

router.get("/jobs/:id", async (req, res): Promise<void> => {
  const userId = actingUserId(req);
  const params = GetJobParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const job = await getUserPosting(userId, params.data.id);
  if (!job) {
    res.status(404).json({ error: "Job not found" });
    return;
  }
  res.json(GetJobResponse.parse(job));
});

router.get("/jobs/:id/cover-letter.pdf", async (req, res): Promise<void> => {
  const userId = actingUserId(req);
  const params = GetJobCoverLetterPdfParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const job = await getUserPosting(userId, params.data.id);
  if (!job) {
    res.status(404).json({ error: "Job not found" });
    return;
  }

  // Binary response - intentionally NOT run through a Zod .parse() (see
  // GET /documents/:type/file for the same rationale).
  const filename = `Cover_Letter_${sanitizeFilenameSegment(job.company)}.pdf`;
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `inline; filename="${filename}"`);
  const doc = renderCoverLetterPdf({ letter: job.coverLetter });
  doc.pipe(res);
});

router.post("/jobs/:id/skip", async (req, res): Promise<void> => {
  const userId = actingUserId(req);
  const params = SkipJobParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const skipped = await skipUserPosting(userId, params.data.id);
  if (!skipped) {
    res.status(404).json({ error: "Job not found" });
    return;
  }
  res.sendStatus(204);
});

router.post("/jobs/refresh", async (req, res): Promise<void> => {
  const userId = actingUserId(req);
  await ensureProfile(userId);
  if (isRefreshRunning()) {
    res.status(202).json(RefreshJobsResponse.parse({ started: false }));
    return;
  }
  // Fire-and-forget: don't block the response on a full aggregation +
  // tailoring cycle, which can take a while. refreshJobListings() has its
  // own overlapping-call guard, so this is safe even if triggered again
  // before it settles.
  // Tailoring, then fit analysis - sequential, never in parallel, so at most
  // one AI provider call for this job pipeline is ever in flight at a time.
  refreshJobListings(userId)
    .then(() => runTailoringPass(userId, 10))
    .then(() => runFitAnalysisPass(userId, 10))
    .catch((err: unknown) => {
      logger.error({ err }, "Manual job refresh failed");
    });
  res.status(202).json(RefreshJobsResponse.parse({ started: true }));
});

export default router;
