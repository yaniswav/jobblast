import { Router, type IRouter } from "express";
import {
  CreateApplicationBody,
  CreateApplicationResponse,
  GetInterviewBriefParams,
  GetInterviewBriefPdfParams,
  GetInterviewBriefResponse,
  ListApplicationsQueryParams,
  ListApplicationsResponse,
  RegenerateInterviewBriefParams,
  RegenerateInterviewBriefResponse,
  UpdateApplicationBody,
  UpdateApplicationParams,
  UpdateApplicationResponse,
} from "@workspace/api-zod";
import {
  ensureInterviewBrief,
  resetInterviewBrief,
  runInterviewBriefPass,
} from "../lib/ai/interview-brief";
import { actingUserId } from "../lib/auth/middleware";
import { logger } from "../lib/logger";
import { renderInterviewBriefPdf } from "../lib/pdf-interview-brief";
import { sanitizeFilenameSegment } from "../lib/pdf-cover-letter";
import {
  createApplication,
  getApplication,
  listApplications,
  updateApplication,
} from "../lib/repo/applications";
import {
  getBrief,
  getReadyBrief,
  type InterviewBrief,
} from "../lib/repo/interview-briefs";
import { ensureProfile } from "../lib/repo/profile";

const router: IRouter = Router();

router.get("/applications", async (req, res): Promise<void> => {
  const userId = actingUserId(req);
  await ensureProfile(userId);
  const query = ListApplicationsQueryParams.safeParse(req.query);
  if (!query.success) {
    res.status(400).json({ error: query.error.message });
    return;
  }
  const applications = await listApplications(userId);
  const filtered = query.data.status
    ? applications.filter((application) => application.status === query.data.status)
    : applications;
  res.json(ListApplicationsResponse.parse(filtered));
});

router.post("/applications", async (req, res): Promise<void> => {
  const userId = actingUserId(req);
  await ensureProfile(userId);
  const body = CreateApplicationBody.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: body.error.message });
    return;
  }

  const result = await createApplication(userId, {
    postingId: body.data.jobId,
    resumeVersion: body.data.resumeVersion,
    coverLetterVersion: body.data.coverLetterVersion,
    notes: body.data.notes ?? "",
  });
  if (!result.ok) {
    res.status(400).json({
      error: result.error === "already-tracked" ? "This job is already tracked" : "Job not found",
    });
    return;
  }

  res.status(201).json(CreateApplicationResponse.parse(result.application));
});

router.patch("/applications/:id", async (req, res): Promise<void> => {
  const userId = actingUserId(req);
  const params = UpdateApplicationParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const body = UpdateApplicationBody.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: body.error.message });
    return;
  }
  // update gains its keys conditionally below; `satisfies` would freeze it to `{}`.
  type ApplicationUpdate = { status?: string; notes?: string; followUpDate?: string | null };
  // eslint-disable-next-line anti-slop/no-known-value-widening
  const update: ApplicationUpdate = {};
  if (body.data.status !== undefined) update.status = body.data.status;
  if (body.data.notes !== undefined) update.notes = body.data.notes;
  if (body.data.followUpDate !== undefined) {
    update.followUpDate =
      body.data.followUpDate === null
        ? null
        : body.data.followUpDate.toISOString().slice(0, 10);
  }
  // Read the row before the write so the interview trigger below fires on
  // the transition into "interview", not on every later save of a row that
  // is already there.
  const previous = await getApplication(userId, params.data.id);
  const application = await updateApplication(userId, params.data.id, update);
  if (!application) {
    res.status(404).json({ error: "Application not found" });
    return;
  }
  // Reaching "interview" queues a preparation brief. The generation itself
  // is a multi-minute web research run, so it happens in the background pass
  // (lib/ai/interview-brief.ts) - this only puts the row in the queue, and
  // never fails the status update if it cannot.
  if (application.status === "interview" && previous?.status !== "interview") {
    await ensureInterviewBrief(userId, application.id);
  }
  res.json(UpdateApplicationResponse.parse(application));
});

// ---------------------------------------------------------------------------
// Interview prep briefs (lib/ai/interview-brief.ts)
// ---------------------------------------------------------------------------

/** The API shape of a brief row. */
function toBriefResponse(brief: InterviewBrief) {
  return {
    status: brief.status,
    contentMarkdown: brief.contentMarkdown,
    generatedAt: brief.generatedAt,
    error: brief.error,
  };
}

router.get("/applications/:id/interview-brief", async (req, res): Promise<void> => {
  const userId = actingUserId(req);
  const params = GetInterviewBriefParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const application = await getApplication(userId, params.data.id);
  if (!application) {
    res.status(404).json({ error: "Application not found" });
    return;
  }

  // Safety net for rows that reached "interview" before this feature existed
  // (or by a path that skipped the trigger): asking for the brief of an
  // application that is in an interview queues it.
  if (application.status === "interview") {
    await ensureInterviewBrief(userId, application.id);
  }

  const brief = await getBrief(userId, application.id);
  if (!brief) {
    res.status(404).json({ error: "No interview brief for this application" });
    return;
  }
  res.json(GetInterviewBriefResponse.parse(toBriefResponse(brief)));
});

router.post("/applications/:id/interview-brief/regenerate", async (req, res): Promise<void> => {
  const userId = actingUserId(req);
  const params = RegenerateInterviewBriefParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const reset = await resetInterviewBrief(userId, params.data.id);
  if (!reset) {
    res.status(404).json({ error: "No interview brief for this application" });
    return;
  }

  // Fire-and-forget, same pattern as POST /jobs/refresh: don't hold the
  // response open for a multi-minute research run. The pass has its own
  // overlapping-call guard, so triggering it again mid-run is a no-op.
  runInterviewBriefPass(userId).catch((err: unknown) => {
    logger.error({ err }, "Manual interview brief regeneration failed");
  });

  const brief = await getBrief(userId, params.data.id);
  res.status(202).json(
    RegenerateInterviewBriefResponse.parse(
      brief ? toBriefResponse(brief) : { status: "pending", contentMarkdown: null, generatedAt: null, error: null },
    ),
  );
});

router.get("/applications/:id/interview-brief.pdf", async (req, res): Promise<void> => {
  const userId = actingUserId(req);
  const params = GetInterviewBriefPdfParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const brief = await getReadyBrief(userId, params.data.id);
  if (!brief?.contentMarkdown) {
    res.status(404).json({ error: "No interview brief ready for this application" });
    return;
  }
  const application = await getApplication(userId, params.data.id);
  if (!application) {
    res.status(404).json({ error: "Application not found" });
    return;
  }

  // Binary response - intentionally NOT run through a Zod .parse() (see
  // GET /documents/:type/file for the same rationale).
  const filename = `Interview_Prep_${sanitizeFilenameSegment(application.company)}.pdf`;
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `inline; filename="${filename}"`);
  const doc = renderInterviewBriefPdf({
    company: application.company,
    title: application.title,
    markdown: brief.contentMarkdown,
    generatedAt: brief.generatedAt,
  });
  doc.pipe(res);
});

export default router;
