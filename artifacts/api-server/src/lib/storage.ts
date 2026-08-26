import path from "node:path";
import { fileURLToPath } from "node:url";

// esbuild bundles everything into a single file at artifacts/api-server/dist/index.mjs,
// so import.meta.url here (regardless of which source file this runs from)
// always resolves to that bundled output's location. Mirrors the staticDir
// resolution in app.ts.
const currentDir = path.dirname(fileURLToPath(import.meta.url));

// dist -> api-server -> artifacts -> repo root
export const REPO_ROOT = path.resolve(currentDir, "../../..");

/**
 * Where an account's files live:
 *
 *   data/users/<uuid>/documents/cv.pdf
 *   data/users/<uuid>/documents/cover_letter.pdf
 *
 * The id is validated before it is joined, so traversal through it is
 * impossible; and because ids are UUIDs, a directory listing does not leak
 * an ordered account count the way serial ids would.
 */
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function userDataDir(userId: string): string {
  if (!UUID_RE.test(userId)) {
    throw new Error("Refusing to build a data path from a non-UUID user id");
  }
  return path.join(REPO_ROOT, "data", "users", userId);
}

export function userDocumentsDir(userId: string): string {
  return path.join(userDataDir(userId), "documents");
}

/**
 * Where uploaded PDFs lived before the layout became per account. Existing
 * self-hosted installs are moved out of it once, idempotently, on first boot
 * (see lib/documents-data.ts).
 */
export const LEGACY_DOCUMENTS_DIR = path.join(REPO_ROOT, "data", "documents");
