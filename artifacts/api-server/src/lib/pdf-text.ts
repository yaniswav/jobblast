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
