import path from "node:path";
import { fileURLToPath } from "node:url";

// esbuild bundles everything into a single file at artifacts/api-server/dist/index.mjs,
// so import.meta.url here (regardless of which source file this runs from)
// always resolves to that bundled output's location. Mirrors the staticDir
// resolution in app.ts.
const currentDir = path.dirname(fileURLToPath(import.meta.url));

// dist -> api-server -> artifacts -> repo root
export const REPO_ROOT = path.resolve(currentDir, "../../..");

// Uploaded PDFs (CV, cover letter) live on disk here, outside the repo's
// tracked files (see .gitignore), with metadata tracked in the `documents`
// DB table (lib/db/src/schema/documents.ts).
export const DOCUMENTS_DIR = path.join(REPO_ROOT, "data", "documents");
