import { Router, type IRouter } from "express";
import { and, eq } from "drizzle-orm";
import {
  CreateApplicationBody,
  CreateApplicationResponse,
  ListApplicationsQueryParams,
  ListApplicationsResponse,
  UpdateApplicationBody,
  UpdateApplicationParams,
  UpdateApplicationResponse,
} from "@workspace/api-zod";
import { applicationsTable, db, jobListingsTable } from "@workspace/db";
import { ensureJobBlastSeeded, getApplications } from "../lib/jobblast-data";

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
  const [application] = await db
    .update(applicationsTable)
    .set(update)
    .where(eq(applicationsTable.id, params.data.id))
    .returning();
  if (!application) {
    res.status(404).json({ error: "Application not found" });
    return;
  }
  res.json(UpdateApplicationResponse.parse(application));
});

export default router;