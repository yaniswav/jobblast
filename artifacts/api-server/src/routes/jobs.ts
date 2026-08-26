import { Router, type IRouter } from "express";
import {
  GetJobCoverLetterPdfParams,
  GetJobParams,
  GetJobResponse,
  GetJobTailoringStatusParams,
  GetJobTailoringStatusResponse,
  ListJobsQueryParams,
  ListJobsResponse,
  RefreshJobsResponse,
  RequestJobTailoringParams,
  RequestJobTailoringResponse,
  SkipJobParams,
} from "@workspace/api-zod";
import { runFitAnalysisPass } from "../lib/ai/fit-analysis";
import { aiDisabledReason, getTextProvider } from "../lib/ai/provider";
import { runTailoringPass, tailorOnePosting } from "../lib/ai/tailor";
import { actingUserId } from "../lib/auth/middleware";
import { logger } from "../lib/logger";
import { IS_SAAS } from "../lib/mode";
import { renderCoverLetterPdf, sanitizeFilenameSegment } from "../lib/pdf-cover-letter";
import { enqueueRefreshForUser, enqueueTailorRequest, tailorDedupeKey } from "../lib/queue/handlers";
import { latestJobFor } from "../lib/queue/store";
import {
  getUserPosting,
  listUserPostings,
  skipUserPosting,
  type UserPostingRow,
} from "../lib/repo/postings";
import { ensureProfile } from "../lib/repo/profile";
import { isRefreshRunning, refreshJobListings } from "../lib/sources/refresh";

const router: IRouter = Router();

type TailoringState = "ready" | "queued" | "running" | "failed" | "template" | "unavailable";

/**
 * Where one posting's cover letter has got to, for this account.
 *
 * In saas a letter only exists because the user asked for it
 * (docs/SAAS-ARCHITECTURE.md section 6), so the review page needs to be able
 * to say "being written" rather than showing a template with no explanation.
 * In selfhosted the eager pass writes them all anyway and this reports the
 * same three obvious states.
 */
async function tailoringStatus(
  userId: string,
  job: UserPostingRow,
): Promise<{ state: TailoringState; error: string | null }> {
  if (job.aiGenerated) return { state: "ready", error: null };

  const provider = await getTextProvider(userId);
  if (!provider) return { state: "unavailable", error: aiDisabledReason(userId) };

  const queued = await latestJobFor(userId, "user.tailor", tailorDedupeKey(userId, job.id));
  if (queued?.status === "pending") return { state: "queued", error: null };
  if (queued?.status === "running") return { state: "running", error: null };
  if (queued?.status === "failed") return { state: "failed", error: queued.lastError };

  return { state: "template", error: null };
}

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

router.get("/jobs/:id/tailor", async (req, res): Promise<void> => {
  const userId = actingUserId(req);
  const params = GetJobTailoringStatusParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const job = await getUserPosting(userId, params.data.id);
  if (!job) {
    res.status(404).json({ error: "Job not found" });
    return;
  }
  res.json(GetJobTailoringStatusResponse.parse(await tailoringStatus(userId, job)));
});

router.post("/jobs/:id/tailor", async (req, res): Promise<void> => {
  const userId = actingUserId(req);
  const params = RequestJobTailoringParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const job = await getUserPosting(userId, params.data.id);
  if (!job) {
    res.status(404).json({ error: "Job not found" });
    return;
  }

  const current = await tailoringStatus(userId, job);
  // Already written, already waiting, or nothing can write it: nothing to ask
  // for, and in particular no second AI call to pay for.
  if (current.state !== "template" && current.state !== "failed") {
    res.status(202).json(RequestJobTailoringResponse.parse(current));
    return;
  }

  if (IS_SAAS) {
    await enqueueTailorRequest(userId, job.id);
    res.status(202).json(RequestJobTailoringResponse.parse({ state: "queued", error: null }));
    return;
  }

  // Self-hosted has no worker loop (its background passes are timers, see
  // src/index.ts), so this runs now and off the response: a letter takes
  // minutes and no browser should hold a connection open for it.
  void tailorOnePosting(userId, job.id).catch((err: unknown) => {
    logger.error({ err, jobId: job.id }, "On-demand tailoring failed");
  });
  res.status(202).json(RequestJobTailoringResponse.parse({ state: "running", error: null }));
});

router.post("/jobs/refresh", async (req, res): Promise<void> => {
  const userId = actingUserId(req);
  await ensureProfile(userId);

  // saas: the refresh is shared, so "refresh now" means "enqueue the fetches
  // this account is waiting on", not "fetch everything again for me".
  if (IS_SAAS) {
    await enqueueRefreshForUser(userId);
    res.status(202).json(RefreshJobsResponse.parse({ started: true }));
    return;
  }

  if (isRefreshRunning(userId)) {
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
