import { integer, pgTable, serial, text, uuid } from "drizzle-orm/pg-core";
import { usersTable } from "./users";

export const profilesTable = pgTable("profiles", {
  id: serial("id").primaryKey(),
  // One profile per account. Self-hosted rows all carry LOCAL_USER_ID.
  userId: uuid("user_id")
    .notNull()
    .unique()
    .references(() => usersTable.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  email: text("email").notNull(),
  headline: text("headline").notNull(),
  targetRoles: text("target_roles").array().notNull(),
  targetLocations: text("target_locations").array().notNull(),
  salaryFloor: integer("salary_floor").notNull(),
  excludedCompanies: text("excluded_companies").array().notNull(),
  // Deprecated by lot I3 (multiple master resumes - see schema/resumes.ts):
  // kept in place, not dropped, because it is cheap infrastructure for a
  // useful invariant rather than dead weight. lib/repo/resumes.ts keeps this
  // column mirroring whichever `resumes` row currently has `isDefault =
  // true`, so every pre-I3 reader of this field (the Profile API, onboarding's
  // "has a resume" check, the follow-up e-mail prompt, ...) keeps working
  // unmodified. New code that needs the resume selected for a specific
  // posting should go through lib/repo/resumes.ts instead.
  masterResume: text("master_resume").notNull(),
});

export type Profile = typeof profilesTable.$inferSelect;
export type InsertProfile = typeof profilesTable.$inferInsert;
