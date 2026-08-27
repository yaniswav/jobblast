// Multiple master resumes per account (lot I3). See lib/repo/resumes.ts for
// the selection logic and the invariant this keeps with `profiles.masterResume`.

import { Router, type IRouter } from "express";
import {
  CreateResumeBody,
  CreateResumeResponse,
  DeleteResumeParams,
  ListResumesResponse,
  SetDefaultResumeParams,
  SetDefaultResumeResponse,
  UpdateResumeBody,
  UpdateResumeParams,
  UpdateResumeResponse,
} from "@workspace/api-zod";
import { actingUserId } from "../lib/auth/middleware";
import {
  createResume,
  deleteResume,
  listResumes,
  setDefaultResume,
  updateResume,
} from "../lib/repo/resumes";

const router: IRouter = Router();

router.get("/resumes", async (req, res): Promise<void> => {
  const userId = actingUserId(req);
  const resumes = await listResumes(userId);
  res.json(ListResumesResponse.parse(resumes));
});

router.post("/resumes", async (req, res): Promise<void> => {
  const userId = actingUserId(req);
  const body = CreateResumeBody.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: body.error.message });
    return;
  }

  const result = await createResume(userId, { label: body.data.label.trim(), content: body.data.content });
  if (!result.ok) {
    res.status(400).json({ error: "This account already has the maximum of 5 resumes" });
    return;
  }
  res.status(201).json(CreateResumeResponse.parse(result.resume));
});

router.patch("/resumes/:id", async (req, res): Promise<void> => {
  const userId = actingUserId(req);
  const params = UpdateResumeParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const body = UpdateResumeBody.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: body.error.message });
    return;
  }

  const patch = body.data.label !== undefined ? { ...body.data, label: body.data.label.trim() } : body.data;
  const resume = await updateResume(userId, params.data.id, patch);
  if (!resume) {
    res.status(404).json({ error: "No such resume for this account" });
    return;
  }
  res.json(UpdateResumeResponse.parse(resume));
});

router.delete("/resumes/:id", async (req, res): Promise<void> => {
  const userId = actingUserId(req);
  const params = DeleteResumeParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const result = await deleteResume(userId, params.data.id);
  if (!result.ok) {
    if (result.error === "last-resume") {
      res.status(400).json({ error: "This is the account's last remaining resume" });
      return;
    }
    res.status(404).json({ error: "No such resume for this account" });
    return;
  }
  res.sendStatus(204);
});

router.post("/resumes/:id/default", async (req, res): Promise<void> => {
  const userId = actingUserId(req);
  const params = SetDefaultResumeParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const result = await setDefaultResume(userId, params.data.id);
  if (!result.ok) {
    res.status(404).json({ error: "No such resume for this account" });
    return;
  }
  res.json(SetDefaultResumeResponse.parse(result.resume));
});

export default router;
