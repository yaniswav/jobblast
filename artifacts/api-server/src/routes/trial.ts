// Anonymous CV-to-postings trial funnel (lot H1, docs/SAAS-ARCHITECTURE.md):
// the proof of value a visitor with no account gets before hitting the
// invite-only signup wall. SaaS mode only, no session required - that is the
// entire point of the feature.
//
// Hard rules, because this is the one place in the whole app that receives
// an unauthenticated stranger's CV:
//   - Zero AI. Matching is deterministic keyword scoring
//     (lib/anonymous-match.ts), the same idea as lib/sources/scoring.ts but
//     generalized into a static list, since there is no account yet to own a
//     per-account configuration.
//   - Zero persistence. Neither handler below ever calls a DB write, a
//     filesystem write, or logger.info/error with the CV text or the PDF
//     bytes - both work entirely on local variables (`req.body.cvText` /
//     `file.buffer`) that simply fall out of scope once the response is
//     sent. Nothing here is cached across requests either: the postings pool
//     is re-read from the DB on every call, so one visitor's request never
//     shapes another's.
//   - The response never includes a posting's application URL or id - that
//     stays a reason to create an account (lib/anonymous-match.ts's
//     AnonymousMatchCard).
//   - Public route: both paths are in lib/auth/middleware.ts's PUBLIC_PATHS
//     allowlist, so the CSRF origin check still runs (requireUser checks
//     origin before consulting that allowlist) but no session is required.

import { Router, type IRouter, type Response } from "express";
import multer from "multer";
import { MatchTrialCvBody } from "@workspace/api-zod";
import { createRateLimiter, type RateLimitDecision } from "../lib/auth/rate-limit";
import {
  ANONYMOUS_POOL_SCAN_LIMIT,
  CV_TEXT_MAX_LENGTH,
  CV_TEXT_MIN_LENGTH,
  matchAnonymousCv,
} from "../lib/anonymous-match";
import { IS_SAAS } from "../lib/mode";
import { extractPdfTextFromBufferWithTimeout, PdfExtractionTimeoutError } from "../lib/pdf-text";
import { listPostingsForAnonymousMatch } from "../lib/repo/postings";

const router: IRouter = Router();

const MAX_PDF_BYTES = 5 * 1024 * 1024; // 5MB, per the H1 brief
const PDF_EXTRACTION_TIMEOUT_MS = 8_000;

// One shared budget across both endpoints (pasted text or PDF): the same
// visitor should not get 5 tries at each just by switching input mode.
const trialIpLimiter = createRateLimiter(24 * 60 * 60 * 1000, 5); // 5 / day per IP

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_PDF_BYTES },
  fileFilter: (_req, file, cb) => {
    if (file.mimetype !== "application/pdf") {
      cb(new Error("Only PDF files are accepted"));
      return;
    }
    cb(null, true);
  },
});

function notAvailable(res: Response): void {
  res.status(404).json({ error: "The anonymous trial is not available on a self-hosted install" });
}

function tooManyRequests(res: Response, decision: RateLimitDecision): void {
  res.set("Retry-After", String(Math.ceil(decision.retryAfterMs / 1000)));
  res.status(429).json({ error: "Too many trial attempts today. Try again tomorrow, or create an account." });
}

/**
 * Scores `cvText` against a bounded, recent slice of the shared pool and
 * writes the result. The only thing that ever touches the database on this
 * path is the read below - there is no write anywhere in this file.
 */
async function respondWithMatch(res: Response, cvText: string): Promise<void> {
  const trimmed = cvText.trim();
  if (trimmed.length < CV_TEXT_MIN_LENGTH) {
    res.status(400).json({ error: "Could not read enough text from that CV to match it." });
    return;
  }

  const postings = await listPostingsForAnonymousMatch(ANONYMOUS_POOL_SCAN_LIMIT);
  res.json(matchAnonymousCv(trimmed, postings));
}

router.post("/trial/match", (req, res, next): void => {
  if (!IS_SAAS) {
    notAvailable(res);
    return;
  }

  const decision = trialIpLimiter.check(req.ip ?? "unknown");
  if (!decision.allowed) {
    tooManyRequests(res, decision);
    return;
  }

  const body = MatchTrialCvBody.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: "Paste your CV as text." });
    return;
  }
  if (body.data.cvText.length > CV_TEXT_MAX_LENGTH) {
    res.status(400).json({ error: "That CV text is too long." });
    return;
  }

  respondWithMatch(res, body.data.cvText).catch(next);
});

router.post("/trial/match/pdf", (req, res, next): void => {
  if (!IS_SAAS) {
    notAvailable(res);
    return;
  }

  const decision = trialIpLimiter.check(req.ip ?? "unknown");
  if (!decision.allowed) {
    tooManyRequests(res, decision);
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

      let cvText: string;
      try {
        cvText = await extractPdfTextFromBufferWithTimeout(file.buffer, PDF_EXTRACTION_TIMEOUT_MS);
      } catch (extractErr) {
        const timedOut = extractErr instanceof PdfExtractionTimeoutError;
        res.status(400).json({
          error: timedOut
            ? "That PDF took too long to read. Try pasting the text instead."
            : "Could not read that PDF. Try pasting the text instead.",
        });
        return;
      }

      await respondWithMatch(res, cvText);
    })().catch(next);
  });
});

export default router;
