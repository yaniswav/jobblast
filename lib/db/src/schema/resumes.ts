// Lot I3: multiple master resumes per account ("Stage FR", "CDI EN", ...).
// Additive table - `profiles.masterResume` (see profiles.ts) stays in place,
// deprecated but not dropped. Reads go through this table, with a fallback
// to `profiles.masterResume` when an account has no rows here yet (see
// lib/repo/resumes.ts's listResumes) - pre-onboarding accounts, and any
// account whose one-time backfill (scripts/src/backfill-resumes.ts) found
// nothing real to seed.
//
// Invariant maintained by lib/repo/resumes.ts: `profiles.masterResume`
// always mirrors whichever resume currently has `isDefault = true`, so every
// existing read of `profiles.masterResume` (the Profile API, onboarding's
// "has a resume" check, the follow-up e-mail prompt, ...) keeps seeing
// sensible content without having to learn about this table. A single-resume
// account is therefore byte-identical to before this lot: one row, always
// default, always the one selected.
//
// No DB-level "at most one default per user" constraint - lib/repo/resumes.ts
// maintains that invariant transactionally on every write (create, update,
// delete, set-default), which keeps this migration purely additive.
import {
  boolean,
  index,
  pgTable,
  serial,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { usersTable } from "./users";

export const resumesTable = pgTable(
  "resumes",
  {
    id: serial("id").primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => usersTable.id, { onDelete: "cascade" }),
    label: text("label").notNull(),
    content: text("content").notNull(),
    isDefault: boolean("is_default").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [index("resumes_user_id_idx").on(table.userId)],
);

export type Resume = typeof resumesTable.$inferSelect;
export type InsertResume = typeof resumesTable.$inferInsert;
