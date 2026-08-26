// Document metadata rows, scoped by account.
//
// The PDF bytes live on disk under data/users/<uuid>/documents (see
// lib/storage.ts); this table only tracks metadata + the on-disk path. No
// file path ever crosses the API boundary: the route looks the row up with
// getDocument(userId, type) and streams `row.path`, so a request for another
// account's document simply finds no row and gets a 404, never a 403 (which
// would confirm existence).

import { and, eq } from "drizzle-orm";
import { db, documentsTable, type Document } from "@workspace/db";

export type { Document } from "@workspace/db";

export type DocumentType = "cv" | "cover_letter";

export async function listDocuments(userId: string): Promise<Document[]> {
  return db.select().from(documentsTable).where(eq(documentsTable.userId, userId));
}

export async function getDocument(
  userId: string,
  type: DocumentType,
): Promise<Document | null> {
  const [row] = await db
    .select()
    .from(documentsTable)
    .where(and(eq(documentsTable.userId, userId), eq(documentsTable.type, type)))
    .limit(1);
  return row ?? null;
}

/** Upserts the metadata row for one document type (never versions). */
export async function upsertDocument(
  userId: string,
  meta: {
    type: DocumentType;
    filename: string;
    mimeType: string;
    path: string;
    sizeBytes: number;
  },
): Promise<Document> {
  const [row] = await db
    .insert(documentsTable)
    .values({ userId, ...meta })
    .onConflictDoUpdate({
      target: [documentsTable.userId, documentsTable.type],
      set: {
        filename: meta.filename,
        mimeType: meta.mimeType,
        path: meta.path,
        sizeBytes: meta.sizeBytes,
        uploadedAt: new Date(),
      },
    })
    .returning();

  if (!row) throw new Error(`Failed to upsert document row for type "${meta.type}"`);
  return row;
}

/** Points an existing row at a new location on disk (used by the data-layout migration). */
export async function moveDocumentPath(
  userId: string,
  type: DocumentType,
  newPath: string,
): Promise<void> {
  await db
    .update(documentsTable)
    .set({ path: newPath })
    .where(and(eq(documentsTable.userId, userId), eq(documentsTable.type, type)));
}
