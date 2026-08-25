import {
  integer,
  pgTable,
  serial,
  text,
  timestamp,
} from "drizzle-orm/pg-core";
import { applicationsTable } from "./applications";

/**
 * The lifecycle of one interview prep brief.
 *
 *   pending    - queued, waiting for the next generation pass
 *   generating - a pass is holding this row right now
 *   ready      - contentMarkdown is populated
 *   failed     - the retry cap was hit; `error` says why
 *
 * A row is created the moment an application reaches status "interview"
 * (from the PATCH route or from the Gmail sync pass), never before: the
 * research run is slow and expensive, so it is only ever paid for once the
 * user actually has an interview to prepare for.
 */
export const INTERVIEW_BRIEF_STATUSES = [
  "pending",
  "generating",
  "ready",
  "failed",
] as const;
export type InterviewBriefStatus = (typeof INTERVIEW_BRIEF_STATUSES)[number];

export const interviewBriefsTable = pgTable("interview_briefs", {
  id: serial("id").primaryKey(),
  // Unique: one brief per application. "Regenerate" resets this row back to
  // "pending" rather than inserting a second one, so the brief stays
  // addressable by application id alone.
  applicationId: integer("application_id")
    .notNull()
    .unique()
    .references(() => applicationsTable.id),
  status: text("status").notNull().default("pending"),
  contentMarkdown: text("content_markdown"),
  generatedAt: timestamp("generated_at", { withTimezone: true }),
  error: text("error"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export type InterviewBrief = typeof interviewBriefsTable.$inferSelect;
export type InsertInterviewBrief = typeof interviewBriefsTable.$inferInsert;
