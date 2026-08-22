import { integer, pgTable, serial, text, timestamp } from "drizzle-orm/pg-core";

// One row per document `type` ("cv" | "cover_letter"). The actual PDF bytes
// live on disk (see artifacts/api-server/src/lib/storage.ts); this table
// only tracks metadata + the on-disk path. Uploading a new file for a type
// replaces the existing row (upsert on `type`) rather than versioning.
export const documentsTable = pgTable("documents", {
  id: serial("id").primaryKey(),
  type: text("type").notNull().unique(),
  filename: text("filename").notNull(),
  mimeType: text("mime_type").notNull(),
  path: text("path").notNull(),
  sizeBytes: integer("size_bytes").notNull(),
  uploadedAt: timestamp("uploaded_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export type Document = typeof documentsTable.$inferSelect;
export type InsertDocument = typeof documentsTable.$inferInsert;
