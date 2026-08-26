import fs from "node:fs";
import { Router, type IRouter } from "express";
import multer from "multer";
import {
  GetDocumentFileParams,
  ListDocumentsResponse,
  UploadDocumentParams,
  UploadDocumentResponse,
} from "@workspace/api-zod";
import { actingUserId } from "../lib/auth/middleware";
import { ensureDocumentsSeeded, saveDocument } from "../lib/documents-data";
import { extractPdfTextFromBuffer } from "../lib/pdf-text";
import { getDocument, listDocuments, type Document } from "../lib/repo/documents";
import { ensureProfile, updateProfile } from "../lib/repo/profile";
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

router.get("/documents", async (req, res): Promise<void> => {
  const userId = actingUserId(req);
  await ensureDocumentsSeeded(userId);
  const docs = await listDocuments(userId);
  res.json(ListDocumentsResponse.parse(docs.map(toDocumentMeta)));
});

router.post("/documents/:type", async (req, res, next): Promise<void> => {
  const userId = actingUserId(req);
  await ensureDocumentsSeeded(userId);
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
        const document = await saveDocument(userId, {
          type,
          filename: file.originalname || `${type}.pdf`,
          mimeType: file.mimetype,
          buffer: file.buffer,
        });

        // A new cover letter can become the AI tailoring reference template
        // (when no explicit template file is configured), so drop the
        // memoized one - see lib/sources/tailoring.ts.
        if (type === "cover_letter") resetCoverLetterTemplateCache(userId);

        // Only the CV upload feeds the master resume - the cover letter
        // upload is stored as-is and never touches profiles.masterResume.
        let resumeUpdated: boolean | undefined;
        if (type === "cv") {
          resumeUpdated = false;
          try {
            const text = (await extractPdfTextFromBuffer(file.buffer)).trim();
            if (text) {
              await ensureProfile(userId);
              const updated = await updateProfile(userId, { masterResume: text });
              resumeUpdated = updated !== null;
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
  const userId = actingUserId(req);
  await ensureDocumentsSeeded(userId);
  const params = GetDocumentFileParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  // Scoped by account: a request for another account's document finds no row
  // and gets a 404, never a 403 (which would confirm existence). No file
  // path ever crosses the API boundary.
  const document = await getDocument(userId, params.data.type);
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
