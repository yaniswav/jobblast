import {
  bigserial,
  date,
  index,
  pgTable,
  text,
  timestamp,
} from "drizzle-orm/pg-core";

/**
 * The shared, platform-wide pool of job adverts: one row per posting, never
 * per user. Everything user-specific about a posting (score, status,
 * tailored letter, fit analysis) lives in `user_postings` instead.
 *
 * A posting is public content, not personal data: deleting an account
 * removes its `user_postings` rows and leaves these standing.
 *
 * `titleCompanyKey` is the normalized "same job, different board" key that
 * used to be recomputed by a full table scan on every refresh; it is stored
 * and indexed here so the soft dedup pass is a lookup.
 */
export const postingsTable = pgTable(
  "postings",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    url: text("url").notNull().unique(),
    source: text("source").notNull(),
    title: text("title").notNull(),
    company: text("company").notNull(),
    companyInitials: text("company_initials").notNull(),
    location: text("location").notNull(),
    workMode: text("work_mode").notNull(),
    description: text("description").notNull(),
    postedDate: date("posted_date", { mode: "string" }).notNull(),
    salaryRange: text("salary_range").notNull(),
    titleCompanyKey: text("title_company_key").notNull(),
    firstSeenAt: timestamp("first_seen_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("postings_title_company_key_idx").on(table.titleCompanyKey),
    index("postings_first_seen_at_idx").on(table.firstSeenAt),
  ],
);

export type Posting = typeof postingsTable.$inferSelect;
export type InsertPosting = typeof postingsTable.$inferInsert;
