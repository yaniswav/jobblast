import {
  bigint,
  date,
  index,
  pgTable,
  serial,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { postingsTable } from "./postings";
import { usersTable } from "./users";

export const applicationsTable = pgTable(
  "applications",
  {
    id: serial("id").primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => usersTable.id, { onDelete: "cascade" }),
    // Points at the shared posting pool. Ids were preserved when
    // `job_listings` was split, so this column did not have to be rewritten.
    jobId: bigint("job_id", { mode: "number" })
      .notNull()
      .references(() => postingsTable.id),
    title: text("title").notNull(),
    company: text("company").notNull(),
    companyInitials: text("company_initials").notNull(),
    location: text("location").notNull(),
    appliedAt: timestamp("applied_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    // "approved" means the tailored application was prepared and the user was
    // routed to the employer's site, but nothing has actually been submitted
    // yet — only an explicit PATCH to "applied" (the user confirming they
    // applied) should ever move a row past this. Defaulting to "applied" here
    // would silently mislead the user into thinking the app submitted on
    // their behalf.
    status: text("status").notNull().default("approved"),
    resumeVersion: text("resume_version").notNull(),
    coverLetterVersion: text("cover_letter_version").notNull(),
    notes: text("notes").notNull().default(""),
    followUpDate: date("follow_up_date", { mode: "string" }),
  },
  (table) => [index("applications_user_id_idx").on(table.userId)],
);

export type Application = typeof applicationsTable.$inferSelect;
export type InsertApplication = typeof applicationsTable.$inferInsert;
