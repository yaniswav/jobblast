import { index, pgTable, primaryKey, smallint, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { usersTable } from "./users";

/**
 * Per-account BYOK AI provider credentials (docs/SAAS-ARCHITECTURE.md
 * section 5, SaaS mode only). The plaintext key is never stored: `iv`,
 * `ciphertext` and `authTag` hold an AES-256-GCM encryption of it (see
 * artifacts/api-server/src/lib/crypto/byok.ts), base64-encoded as `text`
 * rather than `bytea` - the same reason sessions.ts uses hex for
 * `tokenHash` instead of a binary column: it sidesteps node-postgres's
 * binary Buffer handling for a value nothing but this app ever reads.
 *
 * `hint` is the last 4 characters of the plaintext key, safe to show in the
 * UI. The key itself never crosses back out of the API in any form -
 * `decryptCredential()` in lib/repo/ai-credentials.ts is the only reader and
 * only the BYOK "test this key" route calls it.
 */
export const aiCredentialsTable = pgTable(
  "user_ai_credentials",
  {
    userId: uuid("user_id")
      .notNull()
      .references(() => usersTable.id, { onDelete: "cascade" }),
    // AiProviderName narrowed to the BYOK-selectable ones (anthropic-api,
    // openai-compatible) at the application layer - kept as plain text here
    // so adding a third BYOK provider is a code change, not a migration.
    provider: text("provider").notNull(),
    // Bumped by the (future) key-rotation script when JOBBLAST_MASTER_KEY is
    // replaced; carried in the AEAD's associated data so a ciphertext from
    // one key generation can never be decrypted under another.
    keyVersion: smallint("key_version").notNull().default(1),
    iv: text("iv").notNull(),
    ciphertext: text("ciphertext").notNull(),
    authTag: text("auth_tag").notNull(),
    hint: text("hint").notNull(),
    lastOkAt: timestamp("last_ok_at", { withTimezone: true }),
    lastError: text("last_error"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.userId, table.provider] }),
    index("user_ai_credentials_user_id_idx").on(table.userId),
  ],
);

export type AiCredential = typeof aiCredentialsTable.$inferSelect;
export type InsertAiCredential = typeof aiCredentialsTable.$inferInsert;
