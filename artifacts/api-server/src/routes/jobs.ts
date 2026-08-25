import { Router, type IRouter } from "express";
import { eq } from "drizzle-orm";
import {
  GetJobCoverLetterPdfParams,
  GetJobParams,
  GetJobResponse,
  ListJobsQueryParams,
  ListJobsResponse,
  RefreshJobsResponse,
  SkipJobParams,
} from "@workspace/api-zod";
import { db, jobListingsTable } from "@workspace/db";
import { runFitAnalysisPass } from "../lib/ai/fit-analysis";
import { runTailoringPass } from "../lib/ai/tailor";
import {
  ensureJobBlastSeeded,
  getJobWithApplication,
  listJobsWithApplications,
} from "../lib/jobblast-data";
import { logger } from "../lib/logger";
import { renderCoverLetterPdf, sanitizeFilenameSegment } from "../lib/pdf-cover-letter";
import { isRefreshRunning, refreshJobListings } from "../lib/sources/refresh";

const router: IRouter = Router();

router.get("/jobs", async (req, res): Promise<void> => {
  await ensureJobBlastSeeded();
  const query = ListJobsQueryParams.safeParse(req.query);
  if (!query.success) {
    res.status(400).json({ error: query.error.message });
    return;
  }
  const jobs = await listJobsWithApplications();
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
  await ensureJobBlastSeeded();
  const params = GetJobParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const job = await getJobWithApplication(params.data.id);
  if (!job) {
    res.status(404).json({ error: "Job not found" });
    return;
  }
  res.json(GetJobResponse.parse(job));
});

router.get("/jobs/:id/cover-letter.pdf", async (req, res): Promise<void> => {
  await ensureJobBlastSeeded();
  const params = GetJobCoverLetterPdfParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const job = await getJobWithApplication(params.data.id);
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
  await ensureJobBlastSeeded();
  const params = SkipJobParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const [job] = await db
    .update(jobListingsTable)
    .set({ status: "skipped" })
    .where(eq(jobListingsTable.id, params.data.id))
    .returning({ id: jobListingsTable.id });
  if (!job) {
    res.status(404).json({ error: "Job not found" });
    return;
  }
  res.sendStatus(204);
});

router.post("/jobs/refresh", async (_req, res): Promise<void> => {
  await ensureJobBlastSeeded();
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
  refreshJobListings()
    .then(() => runTailoringPass(10))
    .then(() => runFitAnalysisPass(10))
    .catch((err: unknown) => {
      logger.error({ err }, "Manual job refresh failed");
    });
  res.status(202).json(RefreshJobsResponse.parse({ started: true }));
});

export default router;