// Text extraction for uploaded CV PDFs, backing the masterResume update in
// POST /documents/cv (routes/documents.ts).
//
// This originally used `pdf-parse` (the classic, well-known simple API),
// but it has a long-standing bug: its debug-mode detection
// (`let isDebugMode = !module.parent`) misfires whenever the module isn't
// loaded through a traditional `require()` chain with `module.parent`
// populated. Marking it external in build.mjs (so Node's own module loader
// handles it instead of esbuild) did NOT fix this - Node's CJS-via-ESM
// interop for a bundled `import "pdf-parse"` also leaves `module.parent`
// unset, so it still hit the same bug at runtime (ENOENT trying to read a
// hardcoded `test/data/05-versions-space.pdf` fixture that isn't part of
// this project). Switched to `unpdf` instead: a pure-ESM, dependency-light
// wrapper around pdfjs-dist built specifically for server/edge use (no
// worker threads, no DOM/canvas requirement), which bundles cleanly with
// esbuild and needs no external/require workaround.
import { extractText, getDocumentProxy } from "unpdf";

export async function extractPdfTextFromBuffer(buffer: Buffer): Promise<string> {
  const pdf = await getDocumentProxy(new Uint8Array(buffer));
  const { text } = await extractText(pdf, { mergePages: true });
  return text;
}

export class PdfExtractionTimeoutError extends Error {
  constructor() {
    super("PDF text extraction timed out");
    this.name = "PdfExtractionTimeoutError";
  }
}

/**
 * Same extraction, bounded by a wall-clock timeout. Used by the anonymous
 * trial endpoint (routes/trial.ts), which runs against a completely
 * unauthenticated, unrate-limited-by-account upload: a pathological PDF must
 * not be able to tie up a worker on that public path. The authenticated
 * `/documents/:type` upload (routes/documents.ts) keeps calling the plain
 * function above unchanged - that caller is a signed-in account uploading
 * its own file, not the surface this hardening is for.
 */
export async function extractPdfTextFromBufferWithTimeout(
  buffer: Buffer,
  timeoutMs: number,
): Promise<string> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new PdfExtractionTimeoutError()), timeoutMs);
  });
  try {
    return await Promise.race([extractPdfTextFromBuffer(buffer), timeout]);
  } finally {
    clearTimeout(timer!);
  }
}
