import fs from "node:fs";
import path from "node:path";
import { eq } from "drizzle-orm";
import { db, documentsTable, type Document } from "@workspace/db";
import { DOCUMENTS_DIR } from "./storage";
import { logger } from "./logger";

export type DocumentType = "cv" | "cover_letter";

// Documents live on disk in DOCUMENTS_DIR (data/documents/, gitignored) with
// their metadata in the `documents` table. There is no bundled seed content:
// on a machine where the files are already on disk but the DB row is missing
// (fresh database, restored backup, files copied in by hand),
// ensureDocumentsSeeded picks them up. Otherwise nothing is seeded and the
// user uploads their PDFs from the Documents page.
const DOCUMENT_TYPES: DocumentType[] = ["cv", "cover_letter"];

function documentPath(type: DocumentType): string {
  return path.join(DOCUMENTS_DIR, `${type}.pdf`);
}

export async function listDocuments(): Promise<Document[]> {
  return db.select().from(documentsTable);
}

export async function getDocument(type: DocumentType): Promise<Document | null> {
  const [row] = await db.select().from(documentsTable).where(eq(documentsTable.type, type)).limit(1);
  return row ?? null;
}

/** Writes `buffer` to disk for `type` and upserts its metadata row (replaces any existing document of that type). */
export async function saveDocument(params: {
  type: DocumentType;
  filename: string;
  mimeType: string;
  buffer: Buffer;
}): Promise<Document> {
  await fs.promises.mkdir(DOCUMENTS_DIR, { recursive: true });
  const destPath = documentPath(params.type);
  await fs.promises.writeFile(destPath, params.buffer);

  const [row] = await db
    .insert(documentsTable)
    .values({
      type: params.type,
      filename: params.filename,
      mimeType: params.mimeType,
      path: destPath,
      sizeBytes: params.buffer.byteLength,
    })
    .onConflictDoUpdate({
      target: documentsTable.type,
      set: {
        filename: params.filename,
        mimeType: params.mimeType,
        path: destPath,
        sizeBytes: params.buffer.byteLength,
        uploadedAt: new Date(),
      },
    })
    .returning();

  if (!row) {
    throw new Error(`Failed to upsert document row for type "${params.type}"`);
  }
  return row;
}

let seedingDone = false;

/**
 * One-time-per-process check: for each document type with no row yet, adopt
 * the file already sitting at DOCUMENTS_DIR/<type>.pdf if there is one, by
 * inserting its metadata row. Idempotent (checked against the DB, not just
 * the module-level flag) and safe to call repeatedly / concurrently across
 * requests. Never copies anything from outside DOCUMENTS_DIR.
 */
export async function ensureDocumentsSeeded(): Promise<void> {
  if (seedingDone) return;
  seedingDone = true;

  await fs.promises.mkdir(DOCUMENTS_DIR, { recursive: true });

  for (const type of DOCUMENT_TYPES) {
    const existing = await getDocument(type);
    if (existing) continue;

    const onDisk = documentPath(type);
    let stats: fs.Stats;
    try {
      stats = await fs.promises.stat(onDisk);
    } catch {
      continue; // nothing to adopt for this type
    }
    if (!stats.isFile() || stats.size === 0) continue;

    const buffer = await fs.promises.readFile(onDisk);
    await saveDocument({
      type,
      filename: path.basename(onDisk),
      mimeType: "application/pdf",
      buffer,
    });
    logger.info({ type, path: onDisk }, "Adopted existing document file found in data/documents");
  }
}
