import {
  date,
  integer,
  pgTable,
  serial,
  text,
  timestamp,
} from "drizzle-orm/pg-core";
import { jobListingsTable } from "./jobListings";

export const applicationsTable = pgTable("applications", {
  id: serial("id").primaryKey(),
  jobId: integer("job_id")
    .notNull()
    .references(() => jobListingsTable.id),
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
});

export type Application = typeof applicationsTable.$inferSelect;
export type InsertApplication = typeof applicationsTable.$inferInsert;