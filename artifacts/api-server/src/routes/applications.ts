import { Router, type IRouter } from "express";
import { eq } from "drizzle-orm";
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
import { applicationsTable, db, jobListingsTable, type InterviewBrief } from "@workspace/db";
import {
  ensureInterviewBrief,
  getInterviewBriefRow,
  getReadyInterviewBrief,
  resetInterviewBrief,
  runInterviewBriefPass,
} from "../lib/ai/interview-brief";
import { ensureJobBlastSeeded, getApplications } from "../lib/jobblast-data";
import { logger } from "../lib/logger";
import { renderInterviewBriefPdf } from "../lib/pdf-interview-brief";
import { sanitizeFilenameSegment } from "../lib/pdf-cover-letter";

const router: IRouter = Router();

router.get("/applications", async (req, res): Promise<void> => {
  await ensureJobBlastSeeded();
  const query = ListApplicationsQueryParams.safeParse(req.query);
  if (!query.success) {
    res.status(400).json({ error: query.error.message });
    return;
  }
  const applications = await getApplications();
  const filtered = query.data.status
    ? applications.filter((application) => application.status === query.data.status)
    : applications;
  res.json(ListApplicationsResponse.parse(filtered));
});

router.post("/applications", async (req, res): Promise<void> => {
  await ensureJobBlastSeeded();
  const body = CreateApplicationBody.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: body.error.message });
    return;
  }
  const [job] = await db
    .select()
    .from(jobListingsTable)
    .where(eq(jobListingsTable.id, body.data.jobId))
    .limit(1);
  if (!job) {
    res.status(400).json({ error: "Job not found" });
    return;
  }
  const [existing] = await db
    .select({ id: applicationsTable.id })
    .from(applicationsTable)
    .where(eq(applicationsTable.jobId, body.data.jobId))
    .limit(1);
  if (existing) {
    res.status(400).json({ error: "This job is already tracked" });
    return;
  }

  const [application] = await db.transaction(async (tx) => {
    // The application row starts as "approved", not "applied": approving in
    // the review queue only prepares the tailored resume/cover letter and
    // tracks the intent to apply — nothing is actually submitted to the
    // employer here. The user must still apply on the employer's site and
    // then confirm via PATCH /applications/:id (status -> "applied").
    const [created] = await tx
      .insert(applicationsTable)
      .values({
        jobId: job.id,
        title: job.title,
        company: job.company,
        companyInitials: job.companyInitials,
        location: job.location,
        status: "approved",
        resumeVersion: body.data.resumeVersion,
        coverLetterVersion: body.data.coverLetterVersion,
        notes: body.data.notes ?? "",
      })
      .returning();
    // The job listing itself still flips to "applied" so it leaves the
    // review queue (GET /jobs filters queued listings by this status) —
    // that's independent from the application's own status above.
    await tx.update(jobListingsTable).set({ status: "applied" }).where(eq(jobListingsTable.id, job.id));
    return [created];
  });

  res.status(201).json(CreateApplicationResponse.parse(application));
});

router.patch("/applications/:id", async (req, res): Promise<void> => {
  await ensureJobBlastSeeded();
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
  const update: {
    status?: string;
    notes?: string;
    followUpDate?: string | null;
  } = {};
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
  const [previous] = await db
    .select({ status: applicationsTable.status })
    .from(applicationsTable)
    .where(eq(applicationsTable.id, params.data.id))
    .limit(1);
  const [application] = await db
    .update(applicationsTable)
    .set(update)
    .where(eq(applicationsTable.id, params.data.id))
    .returning();
  if (!application) {
    res.status(404).json({ error: "Application not found" });
    return;
  }
  // Reaching "interview" queues a preparation brief. The generation itself
  // is a multi-minute web research run, so it happens in the background pass
  // (lib/ai/interview-brief.ts) - this only puts the row in the queue, and
  // never fails the status update if it cannot.
  if (application.status === "interview" && previous?.status !== "interview") {
    await ensureInterviewBrief(application.id);
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
  await ensureJobBlastSeeded();
  const params = GetInterviewBriefParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const [application] = await db
    .select({ id: applicationsTable.id, status: applicationsTable.status })
    .from(applicationsTable)
    .where(eq(applicationsTable.id, params.data.id))
    .limit(1);
  if (!application) {
    res.status(404).json({ error: "Application not found" });
    return;
  }

  // Safety net for rows that reached "interview" before this feature existed
  // (or by a path that skipped the trigger): asking for the brief of an
  // application that is in an interview queues it.
  if (application.status === "interview") {
    await ensureInterviewBrief(application.id);
  }

  const brief = await getInterviewBriefRow(application.id);
  if (!brief) {
    res.status(404).json({ error: "No interview brief for this application" });
    return;
  }
  res.json(GetInterviewBriefResponse.parse(toBriefResponse(brief)));
});

router.post("/applications/:id/interview-brief/regenerate", async (req, res): Promise<void> => {
  await ensureJobBlastSeeded();
  const params = RegenerateInterviewBriefParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const reset = await resetInterviewBrief(params.data.id);
  if (!reset) {
    res.status(404).json({ error: "No interview brief for this application" });
    return;
  }

  // Fire-and-forget, same pattern as POST /jobs/refresh: don't hold the
  // response open for a multi-minute research run. The pass has its own
  // overlapping-call guard, so triggering it again mid-run is a no-op.
  runInterviewBriefPass().catch((err: unknown) => {
    logger.error({ err }, "Manual interview brief regeneration failed");
  });

  const brief = await getInterviewBriefRow(params.data.id);
  res.status(202).json(
    RegenerateInterviewBriefResponse.parse(
      brief ? toBriefResponse(brief) : { status: "pending", contentMarkdown: null, generatedAt: null, error: null },
    ),
  );
});

router.get("/applications/:id/interview-brief.pdf", async (req, res): Promise<void> => {
  await ensureJobBlastSeeded();
  const params = GetInterviewBriefPdfParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const brief = await getReadyInterviewBrief(params.data.id);
  if (!brief?.contentMarkdown) {
    res.status(404).json({ error: "No interview brief ready for this application" });
    return;
  }
  const [application] = await db
    .select({ title: applicationsTable.title, company: applicationsTable.company })
    .from(applicationsTable)
    .where(eq(applicationsTable.id, params.data.id))
    .limit(1);
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