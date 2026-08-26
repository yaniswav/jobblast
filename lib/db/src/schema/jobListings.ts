import {
  boolean,
  date,
  integer,
  jsonb,
  pgTable,
  serial,
  text,
  timestamp,
} from "drizzle-orm/pg-core";
import type { FitAnalysis } from "./userPostings";

/**
 * LEGACY - replaced by `postings` (shared content) + `user_postings`
 * (per-account score, status and AI output). Nothing in the application
 * reads or writes this table any more; it is still declared here purely so
 * `drizzle-kit push` leaves the existing rows alone. Drop it in a follow-up
 * once the split has been running against real data for a while.
 *
 * @deprecated use `postingsTable` and `userPostingsTable`.
 */
export const jobListingsTable = pgTable("job_listings", {
  id: serial("id").primaryKey(),
  source: text("source").notNull(),
  title: text("title").notNull(),
  company: text("company").notNull(),
  companyInitials: text("company_initials").notNull(),
  location: text("location").notNull(),
  workMode: text("work_mode").notNull(),
  url: text("url").notNull(),
  description: text("description").notNull(),
  postedDate: date("posted_date", { mode: "string" }).notNull(),
  salaryRange: text("salary_range").notNull(),
  fetchedAt: timestamp("fetched_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  relevanceScore: integer("relevance_score").notNull(),
  matchReasons: text("match_reasons").array().notNull(),
  highlightedSkills: text("highlighted_skills").array().notNull(),
  tailoredBullets: text("tailored_bullets").array().notNull(),
  coverLetter: text("cover_letter").notNull(),
  status: text("status").notNull().default("queued"),
  isSeed: boolean("is_seed").notNull().default(false),
  aiGenerated: boolean("ai_generated").notNull().default(false),
  fitAnalysis: jsonb("fit_analysis").$type<FitAnalysis>(),
  fitAnalyzedAt: timestamp("fit_analyzed_at", { withTimezone: true }),
});

export type JobListing = typeof jobListingsTable.$inferSelect;
export type InsertJobListing = typeof jobListingsTable.$inferInsert;
