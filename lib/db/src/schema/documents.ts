import {
  integer,
  pgTable,
  serial,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { usersTable } from "./users";

// One row per account per document `type` ("cv" | "cover_letter"). The
// actual PDF bytes live on disk (see
// artifacts/api-server/src/lib/storage.ts); this table only tracks metadata
// + the on-disk path. Uploading a new file for a type replaces the existing
// row (upsert on user + type) rather than versioning.
//
// No file path ever crosses the API boundary: GET /documents/:type/file
// looks the row up scoped by user and streams `path`, so a request for
// another account's document simply finds no row.
export const documentsTable = pgTable(
  "documents",
  {
    id: serial("id").primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => usersTable.id, { onDelete: "cascade" }),
    type: text("type").notNull(),
    filename: text("filename").notNull(),
    mimeType: text("mime_type").notNull(),
    path: text("path").notNull(),
    sizeBytes: integer("size_bytes").notNull(),
    uploadedAt: timestamp("uploaded_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  // A unique *index* rather than a unique *constraint*: drizzle-kit reads a
  // constraint's columns back in physical table order, and `user_id` was
  // appended to an existing table, so a constraint would read back as
  // (type, user_id) and diff against the schema on every push forever.
  (table) => [
    uniqueIndex("documents_user_id_type_idx").on(table.userId, table.type),
  ],
);

export type Document = typeof documentsTable.$inferSelect;
export type InsertDocument = typeof documentsTable.$inferInsert;
