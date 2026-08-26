import fs from "node:fs";
import path from "node:path";
import { LOCAL_USER_ID, type Document } from "@workspace/db";
import { IS_SAAS } from "./mode";
import { getDocument, moveDocumentPath, upsertDocument, type DocumentType } from "./repo/documents";
import { LEGACY_DOCUMENTS_DIR, userDocumentsDir } from "./storage";
import { logger } from "./logger";

export type { DocumentType } from "./repo/documents";

// Documents live on disk under data/users/<uuid>/documents (gitignored) with
// their metadata in the `documents` table. There is no bundled seed content:
// on a machine where the files are already on disk but the DB row is missing
// (fresh database, restored backup, files copied in by hand),
// ensureDocumentsSeeded picks them up. Otherwise nothing is seeded and the
// user uploads their PDFs from the Documents page.
const DOCUMENT_TYPES: DocumentType[] = ["cv", "cover_letter"];

function documentPath(userId: string, type: DocumentType): string {
  return path.join(userDocumentsDir(userId), `${type}.pdf`);
}

/** Writes `buffer` to disk for `type` and upserts its metadata row (replaces any existing document of that type). */
export async function saveDocument(
  userId: string,
  params: {
    type: DocumentType;
    filename: string;
    mimeType: string;
    buffer: Buffer;
  },
): Promise<Document> {
  const dir = userDocumentsDir(userId);
  await fs.promises.mkdir(dir, { recursive: true });
  const destPath = documentPath(userId, params.type);
  await fs.promises.writeFile(destPath, params.buffer);

  return upsertDocument(userId, {
    type: params.type,
    filename: params.filename,
    mimeType: params.mimeType,
    path: destPath,
    sizeBytes: params.buffer.byteLength,
  });
}

async function isFile(candidate: string): Promise<boolean> {
  try {
    return (await fs.promises.stat(candidate)).isFile();
  } catch {
    return false;
  }
}

/**
 * One-time move of the pre-multi-tenant layout (data/documents/<type>.pdf)
 * into data/users/<uuid>/documents. Idempotent and non-destructive: a file
 * is only moved when the destination does not exist, and the metadata row is
 * repointed after the move.
 *
 * It also self-heals a row whose stored path no longer resolves while the
 * bytes are sitting at the canonical per-account location - the state a
 * half-finished run, a restored backup or a hand-moved file leaves behind.
 *
 * Only ever runs for the implicit local user, and only in `selfhosted`: that
 * pre-multi-tenant directory belonged to exactly one person, and handing it
 * to whoever happens to register first would be a data leak.
 */
async function migrateLegacyDocuments(userId: string): Promise<void> {
  if (IS_SAAS || userId !== LOCAL_USER_ID) return;

  const dir = userDocumentsDir(userId);

  for (const type of DOCUMENT_TYPES) {
    const legacyPath = path.join(LEGACY_DOCUMENTS_DIR, `${type}.pdf`);
    const destPath = documentPath(userId, type);

    if ((await isFile(legacyPath)) && !(await isFile(destPath))) {
      await fs.promises.mkdir(dir, { recursive: true });
      await fs.promises.rename(legacyPath, destPath);
      await moveDocumentPath(userId, type, destPath);
      logger.info({ type, from: legacyPath, to: destPath }, "Moved document into the per-account data layout");
      continue;
    }

    const row = await getDocument(userId, type);
    if (row && row.path !== destPath && !(await isFile(row.path)) && (await isFile(destPath))) {
      await moveDocumentPath(userId, type, destPath);
      logger.info({ type, from: row.path, to: destPath }, "Repointed a document row at the per-account data layout");
    }
  }
}

const seedingDone = new Set<string>();

/**
 * One-time-per-process, per-account check: migrate the legacy layout if it
 * is still there, then for each document type with no row yet adopt the file
 * already sitting at data/users/<uuid>/documents/<type>.pdf. Idempotent
 * (checked against the DB, not just the in-process set) and safe to call
 * repeatedly / concurrently across requests. Never copies anything from
 * outside the account's own directory.
 */
export async function ensureDocumentsSeeded(userId: string): Promise<void> {
  if (seedingDone.has(userId)) return;
  seedingDone.add(userId);

  const dir = userDocumentsDir(userId);
  await fs.promises.mkdir(dir, { recursive: true });
  await migrateLegacyDocuments(userId);

  for (const type of DOCUMENT_TYPES) {
    const existing = await getDocument(userId, type);
    if (existing) continue;

    const onDisk = documentPath(userId, type);
    let stats: fs.Stats;
    try {
      stats = await fs.promises.stat(onDisk);
    } catch {
      continue; // nothing to adopt for this type
    }
    if (!stats.isFile() || stats.size === 0) continue;

    const buffer = await fs.promises.readFile(onDisk);
    await saveDocument(userId, {
      type,
      filename: path.basename(onDisk),
      mimeType: "application/pdf",
      buffer,
    });
    logger.info({ type, path: onDisk }, "Adopted existing document file found on disk");
  }
}
