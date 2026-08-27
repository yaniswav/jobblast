import {
  index,
  integer,
  jsonb,
  pgTable,
  serial,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { applicationsTable } from "./applications";
import { usersTable } from "./users";

/**
 * The per-application timeline (lot I1): every notable thing that happened
 * to one tracked application, in one place, instead of scattered across the
 * free-text `notes` column and the Gmail sync journal file
 * (data/gmail-sync-journal.jsonl, which stays the operator's audit trail and
 * is not superseded by this table).
 *
 *   applied         - the application was created (PATCH into "applied" is
 *                      not this kind - see status_changed - "applied" here
 *                      is the tracker row's creation, mirroring
 *                      applications.appliedAt).
 *   status_changed   - `payload` carries { from, to, origin }, where origin
 *                      is "manual" (the PATCH /applications/:id route) or
 *                      "gmail" (lib/gmail-sync.ts). A gmail-origin row also
 *                      carries a short synthetic `subject`, never the
 *                      e-mail's excerpt/body - see
 *                      lib/application-events.ts's buildEmailSubject().
 *   followed_up      - the user pressed "I followed up" (lot H4). `payload`
 *                      carries { followUpCount }.
 *   note_added        - a personal note appended via POST
 *                      /applications/:id/notes. `payload` carries { text },
 *                      capped at 2000 chars. Append-only: this lot has no
 *                      edit or delete for notes.
 *   email_detected    - lib/gmail-sync.ts matched (or nearly matched, then
 *                      declined) an e-mail to this application. `payload`
 *                      carries { kind, verdict, subject } - again a
 *                      synthetic subject, never the e-mail's excerpt/body.
 *   brief_generated   - an interview prep brief finished generating
 *                      (lib/ai/interview-brief.ts).
 *
 * Every row is written fire-and-forget by lib/application-events.ts's
 * recordApplicationEvent(): a failed insert here must never fail the
 * action that triggered it.
 *
 * Additive only - see this lot's migration notes. Not FK'd from anywhere,
 * cascades away when the application (or the account) is deleted.
 */
export const APPLICATION_EVENT_KINDS = [
  "applied",
  "status_changed",
  "followed_up",
  "note_added",
  "email_detected",
  "brief_generated",
] as const;
export type ApplicationEventKind = (typeof APPLICATION_EVENT_KINDS)[number];

export const applicationEventsTable = pgTable(
  "application_events",
  {
    id: serial("id").primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => usersTable.id, { onDelete: "cascade" }),
    applicationId: integer("application_id")
      .notNull()
      .references(() => applicationsTable.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(),
    // Defaults to "now" but is explicitly set for events that describe
    // something that already happened at a specific instant (the backfill's
    // "applied" event dated to the original appliedAt, "followed_up" dated
    // to lastFollowedUpAt) - see this lot's backfill script.
    occurredAt: timestamp("occurred_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    // The timeline query: every event for one application, newest first.
    index("application_events_application_id_idx").on(
      table.applicationId,
      table.occurredAt,
    ),
    index("application_events_user_id_idx").on(table.userId),
  ],
);

export type ApplicationEvent = typeof applicationEventsTable.$inferSelect;
export type InsertApplicationEvent = typeof applicationEventsTable.$inferInsert;
