import { Router, type IRouter } from "express";
import { eq } from "drizzle-orm";
import { GetProfileResponse, UpdateProfileBody, UpdateProfileResponse } from "@workspace/api-zod";
import { db, profilesTable } from "@workspace/db";
import { ensureJobBlastSeeded } from "../lib/jobblast-data";

const router: IRouter = Router();

router.get("/profile", async (_req, res): Promise<void> => {
  await ensureJobBlastSeeded();
  const [profile] = await db.select().from(profilesTable).limit(1);
  res.json(GetProfileResponse.parse(profile));
});

router.patch("/profile", async (req, res): Promise<void> => {
  await ensureJobBlastSeeded();
  const body = UpdateProfileBody.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: body.error.message });
    return;
  }
  const [current] = await db.select().from(profilesTable).limit(1);
  if (!current) {
    res.status(404).json({ error: "Profile not found" });
    return;
  }
  const [profile] = await db
    .update(profilesTable)
    .set(body.data)
    .where(eq(profilesTable.id, current.id))
    .returning();
  res.json(UpdateProfileResponse.parse(profile));
});

export default router;