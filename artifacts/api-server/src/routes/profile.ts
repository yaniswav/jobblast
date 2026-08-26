import { Router, type IRouter } from "express";
import { GetProfileResponse, UpdateProfileBody, UpdateProfileResponse } from "@workspace/api-zod";
import { actingUserId } from "../lib/auth/middleware";
import { ensureProfile, updateProfile } from "../lib/repo/profile";

const router: IRouter = Router();

router.get("/profile", async (req, res): Promise<void> => {
  const userId = actingUserId(req);
  const profile = await ensureProfile(userId);
  res.json(GetProfileResponse.parse(profile));
});

router.patch("/profile", async (req, res): Promise<void> => {
  const userId = actingUserId(req);
  await ensureProfile(userId);
  const body = UpdateProfileBody.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: body.error.message });
    return;
  }
  const profile = await updateProfile(userId, body.data);
  if (!profile) {
    res.status(404).json({ error: "Profile not found" });
    return;
  }
  res.json(UpdateProfileResponse.parse(profile));
});

export default router;
