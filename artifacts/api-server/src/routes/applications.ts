import { Router, type IRouter } from "express";
import {
  AddApplicationNoteBody,
  AddApplicationNoteParams,
  AddApplicationNoteResponse,
  CreateApplicationBody,
  CreateApplicationResponse,
  GetFollowUpEmailParams,
  GetFollowUpEmailResponse,
  GetInterviewBriefParams,
  GetInterviewBriefPdfParams,
  GetInterviewBriefResponse,
  GetInterviewIcsParams,
  ListApplicationEventsParams,
  ListApplicationEventsResponse,
  ListApplicationsQueryParams,
  ListApplicationsResponse,
  MarkFollowedUpParams,
  MarkFollowedUpResponse,
  RegenerateInterviewBriefParams,
  RegenerateInterviewBriefResponse,
  UpdateApplicationBody,
  UpdateApplicationParams,
  UpdateApplicationResponse,
} from "@workspace/api-zod";
import { generateFollowUpEmail } from "../lib/ai/follow-up";
import {
  ensureInterviewBrief,
  resetInterviewBrief,
  runInterviewBriefPass,
} from "../lib/ai/interview-brief";
import {
  buildStatusChangedPayload,
  normalizeNoteText,
  recordApplicationEvent,
} from "../lib/application-events";
import { actingUserId } from "../lib/auth/middleware";
import { getUserById } from "../lib/auth/store";
import { loadConfig } from "../lib/config";
import { resolveEmailLocale } from "../lib/email";
import { withFollowUpEligibility } from "../lib/follow-ups";
import { buildInterviewIcs } from "../lib/ics";
import { logger } from "../lib/logger";
import { renderInterviewBriefPdf } from "../lib/pdf-interview-brief";
import { sanitizeFilenameSegment } from "../lib/pdf-cover-letter";
import {
  createApplication,
  getApplication,
  getApplicationWithPosting,
  listApplications,
  markFollowedUp,
  updateApplication,
  type Application,
} from "../lib/repo/applications";
import { listApplicationEvents } from "../lib/repo/application-events";
import {
  getBrief,
  getReadyBrief,
  type InterviewBrief,
} from "../lib/repo/interview-briefs";
import { ensureProfile, getProfile } from "../lib/repo/profile";

const router: IRouter = Router();

/** Every Application response carries the follow-up eligibility computed against "now" and the account's delay setting. */
function toApplicationResponse(application: Application) {
  const { afterDays } = loadConfig().followUps;
  return withFollowUpEligibility(application, new Date(), afterDays);
}

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
  res.json(ListApplicationsResponse.parse(filtered.map(toApplicationResponse)));
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

  await recordApplicationEvent(
    userId,
    result.application.id,
    { kind: "applied" },
    result.application.appliedAt,
  );

  res.status(201).json(CreateApplicationResponse.parse(toApplicationResponse(result.application)));
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
  type ApplicationUpdate = {
    status?: string;
    notes?: string;
    followUpDate?: string | null;
    interviewAt?: Date | null;
  };
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
  // Lot I2: set, move or clear the scheduled interview date/time. No status
  // requirement, same as followUpDate above - a user can schedule ahead of
  // the row actually reaching "interview".
  if (body.data.interviewAt !== undefined) update.interviewAt = body.data.interviewAt;
  // Read the row before the write so the interview trigger below fires on
  // the transition into "interview", not on every later save of a row that
  // is already there.
  const previous = await getApplication(userId, params.data.id);
  const application = await updateApplication(userId, params.data.id, update);
  if (!application) {
    res.status(404).json({ error: "Application not found" });
    return;
  }
  // A manual status move, timelined. gmail-sync.ts records its own
  // status_changed events (origin "gmail") at the point it applies a move -
  // see that file's header.
  if (update.status !== undefined && previous && previous.status !== application.status) {
    await recordApplicationEvent(userId, application.id, {
      kind: "status_changed",
      payload: buildStatusChangedPayload({
        from: previous.status,
        to: application.status,
        origin: "manual",
      }),
    });
  }
  // Reaching "interview" queues a preparation brief. The generation itself
  // is a multi-minute web research run, so it happens in the background pass
  // (lib/ai/interview-brief.ts) - this only puts the row in the queue, and
  // never fails the status update if it cannot.
  if (application.status === "interview" && previous?.status !== "interview") {
    await ensureInterviewBrief(userId, application.id);
  }
  // The interview date was set, moved or cleared - timelined the same way a
  // status change is, but only when it actually changed (a save that leaves
  // interviewAt untouched writes nothing here).
  if (
    update.interviewAt !== undefined &&
    previous &&
    (previous.interviewAt?.getTime() ?? null) !== (application.interviewAt?.getTime() ?? null)
  ) {
    await recordApplicationEvent(userId, application.id, {
      kind: "interview_scheduled",
      payload: { interviewAt: application.interviewAt ? application.interviewAt.toISOString() : null },
    });
  }
  res.json(UpdateApplicationResponse.parse(toApplicationResponse(application)));
});

// ---------------------------------------------------------------------------
// Interview calendar file (lot I2, lib/ics.ts)
//
// A plain RFC 5545 .ics download for the interview date set via the PATCH
// above - role, company, location and time, plus one line mentioning a
// brief exists when one is ready. Never the brief's own content - see
// lib/ics.ts's header.
// ---------------------------------------------------------------------------

router.get("/applications/:id/interview.ics", async (req, res): Promise<void> => {
  const userId = actingUserId(req);
  const params = GetInterviewIcsParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const application = await getApplication(userId, params.data.id);
  if (!application) {
    res.status(404).json({ error: "Application not found" });
    return;
  }
  if (!application.interviewAt) {
    res.status(404).json({ error: "No interview date set for this application" });
    return;
  }

  const [brief, user] = await Promise.all([
    getReadyBrief(userId, application.id),
    getUserById(userId),
  ]);

  const ics = buildInterviewIcs({
    applicationId: application.id,
    title: application.title,
    company: application.company,
    location: application.location,
    interviewAt: application.interviewAt,
    hasBrief: Boolean(brief),
    host: req.hostname,
    locale: resolveEmailLocale(user?.locale),
  });

  // Binary-ish text response - intentionally NOT run through a Zod .parse()
  // (see GET /documents/:type/file for the same rationale).
  const filename = `Interview_${sanitizeFilenameSegment(application.company)}.ics`;
  res.setHeader("Content-Type", "text/calendar; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
  res.send(ics);
});

// ---------------------------------------------------------------------------
// Follow-up nudges (lot H4, lib/follow-ups.ts + lib/ai/follow-up.ts)
//
// JobBlast never sends a follow-up e-mail itself - GET only drafts text, and
// POST only records that the USER sent one from their own mailbox. Both
// routes are restricted to status "applied": a reply was already detected
// (gmail-sync.ts moved the row on), or the application was never actually
// sent, so a follow-up would misrepresent the situation either way.
// ---------------------------------------------------------------------------

router.get("/applications/:id/follow-up", async (req, res): Promise<void> => {
  const userId = actingUserId(req);
  const params = GetFollowUpEmailParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const input = await getApplicationWithPosting(userId, params.data.id);
  if (!input) {
    res.status(404).json({ error: "Application not found" });
    return;
  }
  const { application, posting } = input;

  if (application.status !== "applied") {
    res.status(400).json({
      error: "A follow-up e-mail can only be prepared for an application that was sent and has not received a reply yet",
    });
    return;
  }

  const profile = await getProfile(userId);
  const email = await generateFollowUpEmail(userId, {
    masterResume: profile?.masterResume ?? "",
    headline: profile?.headline ?? "",
    title: application.title || posting.title,
    company: application.company || posting.company,
    location: application.location || posting.location,
    description: posting.description,
    appliedAt: application.appliedAt,
    now: new Date(),
  });

  res.json(GetFollowUpEmailResponse.parse(email));
});

router.post("/applications/:id/follow-up", async (req, res): Promise<void> => {
  const userId = actingUserId(req);
  const params = MarkFollowedUpParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const existing = await getApplication(userId, params.data.id);
  if (!existing) {
    res.status(404).json({ error: "Application not found" });
    return;
  }
  if (existing.status !== "applied") {
    res.status(400).json({ error: "Only an application awaiting a reply can be marked as followed up" });
    return;
  }

  const updated = await markFollowedUp(userId, params.data.id);
  if (!updated) {
    res.status(404).json({ error: "Application not found" });
    return;
  }

  await recordApplicationEvent(
    userId,
    updated.id,
    { kind: "followed_up", payload: { followUpCount: updated.followUpCount } },
    updated.lastFollowedUpAt ?? undefined,
  );

  logger.info({ applicationId: updated.id, followUpCount: updated.followUpCount }, "Follow-up confirmed by the user");
  res.json(MarkFollowedUpResponse.parse(toApplicationResponse(updated)));
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

// ---------------------------------------------------------------------------
// Timeline (lot I1, lib/application-events.ts)
//
// GET returns everything recorded for one application, newest first. POST
// appends a personal note - append-only, no edit or delete in this lot.
// ---------------------------------------------------------------------------

router.get("/applications/:id/events", async (req, res): Promise<void> => {
  const userId = actingUserId(req);
  const params = ListApplicationEventsParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const application = await getApplication(userId, params.data.id);
  if (!application) {
    res.status(404).json({ error: "Application not found" });
    return;
  }

  const events = await listApplicationEvents(userId, params.data.id);
  res.json(ListApplicationEventsResponse.parse(events));
});

router.post("/applications/:id/notes", async (req, res): Promise<void> => {
  const userId = actingUserId(req);
  const params = AddApplicationNoteParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const body = AddApplicationNoteBody.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: body.error.message });
    return;
  }

  const application = await getApplication(userId, params.data.id);
  if (!application) {
    res.status(404).json({ error: "Application not found" });
    return;
  }

  const text = normalizeNoteText(body.data.text);
  if (!text) {
    res.status(400).json({ error: "A note must be 1 to 2000 characters long" });
    return;
  }

  const event = await recordApplicationEvent(userId, application.id, {
    kind: "note_added",
    payload: { text },
  });
  if (!event) {
    // The one place this lot's "never fail the caller" rule does not apply:
    // there is no caller action here other than recording the note, so a
    // failed insert IS the failure to report.
    res.status(500).json({ error: "Could not save the note" });
    return;
  }

  res.status(201).json(AddApplicationNoteResponse.parse(event));
});

export default router;
