import { integer, pgTable, serial, text } from "drizzle-orm/pg-core";

export const profilesTable = pgTable("profiles", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull(),
  headline: text("headline").notNull(),
  targetRoles: text("target_roles").array().notNull(),
  targetLocations: text("target_locations").array().notNull(),
  salaryFloor: integer("salary_floor").notNull(),
  excludedCompanies: text("excluded_companies").array().notNull(),
  masterResume: text("master_resume").notNull(),
});

export type Profile = typeof profilesTable.$inferSelect;
export type InsertProfile = typeof profilesTable.$inferInsert;