import fs from "node:fs";
import { Router, type IRouter } from "express";
import { eq } from "drizzle-orm";
import multer from "multer";
import {
  GetDocumentFileParams,
  ListDocumentsResponse,
  UploadDocumentParams,
  UploadDocumentResponse,
} from "@workspace/api-zod";
import { db, profilesTable, type Document } from "@workspace/db";
import { ensureDocumentsSeeded, getDocument, listDocuments, saveDocument } from "../lib/documents-data";
import { extractPdfTextFromBuffer } from "../lib/pdf-text";
import { resetCoverLetterTemplateCache } from "../lib/sources/tailoring";
import { logger } from "../lib/logger";

const router: IRouter = Router();

const MAX_UPLOAD_BYTES = 10 * 1024 * 1024; // 10MB

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_UPLOAD_BYTES },
  fileFilter: (_req, file, cb) => {
    if (file.mimetype !== "application/pdf") {
      cb(new Error("Only PDF files are accepted"));
      return;
    }
    cb(null, true);
  },
});

function toDocumentMeta(doc: Document) {
  return {
    type: doc.type,
    filename: doc.filename,
    sizeBytes: doc.sizeBytes,
    uploadedAt: doc.uploadedAt,
  };
}

router.get("/documents", async (_req, res): Promise<void> => {
  await ensureDocumentsSeeded();
  const docs = await listDocuments();
  res.json(ListDocumentsResponse.parse(docs.map(toDocumentMeta)));
});

router.post("/documents/:type", async (req, res, next): Promise<void> => {
  await ensureDocumentsSeeded();
  const params = UploadDocumentParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  upload.single("file")(req, res, (err: unknown) => {
    void (async () => {
      if (err) {
        res.status(400).json({ error: err instanceof Error ? err.message : "Invalid upload" });
        return;
      }
      const file = req.file;
      if (!file) {
        res.status(400).json({ error: "Missing file" });
        return;
      }

      try {
        const type = params.data.type;
        const document = await saveDocument({
          type,
          filename: file.originalname || `${type}.pdf`,
          mimeType: file.mimetype,
          buffer: file.buffer,
        });

        // A new cover letter can become the AI tailoring reference template
        // (when no explicit template file is configured), so drop the
        // memoized one - see lib/sources/tailoring.ts.
        if (type === "cover_letter") resetCoverLetterTemplateCache();

        // Only the CV upload feeds the master resume - the cover letter
        // upload is stored as-is and never touches profiles.masterResume.
        let resumeUpdated: boolean | undefined;
        if (type === "cv") {
          resumeUpdated = false;
          try {
            const text = (await extractPdfTextFromBuffer(file.buffer)).trim();
            if (text) {
              const [profile] = await db.select().from(profilesTable).limit(1);
              if (profile) {
                await db
                  .update(profilesTable)
                  .set({ masterResume: text })
                  .where(eq(profilesTable.id, profile.id));
                resumeUpdated = true;
              }
            }
          } catch (extractErr) {
            logger.error(
              { err: extractErr },
              "CV text extraction failed; profiles.masterResume left unchanged",
            );
          }
        }

        res.json(
          UploadDocumentResponse.parse({
            ...toDocumentMeta(document),
            resumeUpdated,
          }),
        );
      } catch (saveErr) {
        next(saveErr);
      }
    })();
  });
});

router.get("/documents/:type/file", async (req, res): Promise<void> => {
  await ensureDocumentsSeeded();
  const params = GetDocumentFileParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const document = await getDocument(params.data.type);
  if (!document) {
    res.status(404).json({ error: "Document not found" });
    return;
  }

  // Binary response - intentionally NOT run through a Zod .parse(). The
  // generated GetDocumentFileResponse schema is `zod.unknown()` for this
  // content type (orval has no meaningful way to validate a binary body),
  // so this route hand-rolls the response instead.
  res.setHeader("Content-Type", document.mimeType);
  res.setHeader(
    "Content-Disposition",
    `inline; filename="${document.filename.replace(/"/g, "")}"`,
  );
  fs.createReadStream(document.path).pipe(res);
});

export default router;
