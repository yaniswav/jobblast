// One-time, idempotent migration to the multi-tenant schema (v0.3 lot B).
//
// Run it BEFORE `pnpm run db:push`: drizzle-kit push cannot express the
// ordering this needs (create the shared pool, copy the rows across
// preserving ids, repoint the foreign key, only then make the new columns
// NOT NULL), and a push against the pre-split database would either fail on
// the existing rows or rewrite them.
//
//   pnpm run db:migrate -- --dry-run   report what it would do, change nothing
//   pnpm run db:migrate                apply
//
// What it does, all of it guarded so a second run is a no-op:
//
//   1. creates `users`, `sessions`, `invite_codes`, `user_settings`
//   2. seeds the implicit local user every self-hosted install runs as
//   3. creates `postings` (shared advert pool) + `user_postings` (per
//      account score/status/AI output) and copies `job_listings` across,
//      preserving ids so `applications.job_id` stays valid
//   4. adds `user_id` to profiles / applications / documents /
//      interview_briefs, backfilled to the local user
//   5. repoints `applications.job_id` at `postings`
//
// It never drops a table or a column. `job_listings` is left exactly as it
// was, as a read-only safety net until the split has proven itself.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const currentDir = path.dirname(fileURLToPath(import.meta.url));
// scripts/src -> scripts -> repo root
const REPO_ROOT = path.resolve(currentDir, "../..");

// Nothing loads the repo-root .env for a plain `tsx` process (mirrors
// lib/db/drizzle.config.ts), and @workspace/db throws at import time without
// DATABASE_URL - so read it here, then import the pool dynamically.
if (!process.env["DATABASE_URL"]) {
  const envFile = path.join(REPO_ROOT, ".env");
  if (fs.existsSync(envFile)) {
    for (const line of fs.readFileSync(envFile, "utf8").split(/\r?\n/)) {
      const match = /^\s*([\w.-]+)\s*=\s*(.*?)\s*$/.exec(line);
      if (match?.[1] && !process.env[match[1]]) {
        process.env[match[1]] = match[2]!.replace(/^["']|["']$/g, "");
      }
    }
  }
}

const { pool, LOCAL_USER_ID } = await import("@workspace/db");

const dryRun = process.argv.includes("--dry-run");

/** Normalized "same job posted on two boards" key. Mirrors titleCompanyKey() in lib/sources/refresh.ts. */
const TITLE_COMPANY_KEY_SQL = `
  lower(regexp_replace(btrim(title), '\\s+', ' ', 'g')) || '|' ||
  lower(regexp_replace(btrim(company), '\\s+', ' ', 'g'))
`;

const STATEMENTS: Array<{ label: string; sql: string }> = [
  {
    label: "users",
    sql: `
      create table if not exists users (
        id uuid primary key default gen_random_uuid(),
        email text not null,
        password_hash text not null,
        email_verified boolean not null default false,
        display_name text,
        locale text,
        status text not null default 'active',
        created_at timestamptz not null default now(),
        last_login_at timestamptz,
        constraint users_email_unique unique (email)
      );
    `,
  },
  {
    label: "local user seed",
    sql: `
      insert into users (id, email, password_hash, display_name)
      values ('${LOCAL_USER_ID}', 'local@jobblast.local', '', 'Local user')
      on conflict (id) do nothing;
    `,
  },
  {
    label: "sessions",
    sql: `
      create table if not exists sessions (
        id uuid primary key default gen_random_uuid(),
        user_id uuid not null constraint sessions_user_id_users_id_fk references users(id) on delete cascade,
        token_hash text not null,
        created_at timestamptz not null default now(),
        last_seen_at timestamptz not null default now(),
        expires_at timestamptz not null,
        user_agent text,
        ip_hash text,
        constraint sessions_token_hash_unique unique (token_hash)
      );
      create index if not exists sessions_user_id_idx on sessions(user_id);
      create index if not exists sessions_expires_at_idx on sessions(expires_at);
    `,
  },
  {
    label: "invite_codes",
    sql: `
      create table if not exists invite_codes (
        code text primary key,
        note text not null default '',
        max_uses integer not null default 1,
        used_count integer not null default 0,
        created_at timestamptz not null default now(),
        expires_at timestamptz
      );
    `,
  },
  {
    label: "user_settings",
    sql: `
      create table if not exists user_settings (
        user_id uuid primary key constraint user_settings_user_id_users_id_fk references users(id) on delete cascade,
        config jsonb not null default '{}'::jsonb,
        updated_at timestamptz not null default now()
      );
    `,
  },
  {
    label: "postings",
    sql: `
      create table if not exists postings (
        id bigserial primary key,
        url text not null,
        source text not null,
        title text not null,
        company text not null,
        company_initials text not null,
        location text not null,
        work_mode text not null,
        description text not null,
        posted_date date not null,
        salary_range text not null,
        title_company_key text not null,
        first_seen_at timestamptz not null default now(),
        last_seen_at timestamptz not null default now(),
        constraint postings_url_unique unique (url)
      );
      create index if not exists postings_title_company_key_idx on postings(title_company_key);
      create index if not exists postings_first_seen_at_idx on postings(first_seen_at);
    `,
  },
  {
    label: "user_postings",
    sql: `
      create table if not exists user_postings (
        user_id uuid not null constraint user_postings_user_id_users_id_fk references users(id) on delete cascade,
        posting_id bigint not null constraint user_postings_posting_id_postings_id_fk references postings(id) on delete cascade,
        relevance_score integer not null default 0,
        match_reasons text[] not null default '{}',
        highlighted_skills text[] not null default '{}',
        status text not null default 'queued',
        tailored_bullets text[] not null default '{}',
        cover_letter text not null default '',
        ai_generated boolean not null default false,
        fit_analysis jsonb,
        fit_analyzed_at timestamptz,
        created_at timestamptz not null default now(),
        constraint user_postings_user_id_posting_id_pk primary key (user_id, posting_id)
      );
      create index if not exists user_postings_queue_idx
        on user_postings(user_id, status, relevance_score);
    `,
  },
  {
    // DISTINCT ON keeps one posting per url. Preference order: a listing an
    // application already points at wins (so no tracked application is left
    // dangling), then the lowest id.
    label: "copy job_listings -> postings",
    sql: `
      insert into postings (
        id, url, source, title, company, company_initials, location, work_mode,
        description, posted_date, salary_range, title_company_key, first_seen_at, last_seen_at
      )
      select distinct on (url)
        id, url, source, title, company, company_initials, location, work_mode,
        description, posted_date, salary_range, ${TITLE_COMPANY_KEY_SQL}, fetched_at, fetched_at
      from job_listings
      order by url, (exists (select 1 from applications a where a.job_id = job_listings.id)) desc, id
      on conflict (id) do nothing;
    `,
  },
  {
    // A listing dropped as a url duplicate above may still be referenced by
    // an application: point it at the posting that survived for that url.
    label: "repoint applications at surviving postings",
    sql: `
      update applications a
      set job_id = p.id
      from job_listings jl
      join postings p on p.url = jl.url
      where a.job_id = jl.id and a.job_id <> p.id;
    `,
  },
  {
    label: "copy job_listings -> user_postings",
    sql: `
      insert into user_postings (
        user_id, posting_id, relevance_score, match_reasons, highlighted_skills,
        status, tailored_bullets, cover_letter, ai_generated, fit_analysis,
        fit_analyzed_at, created_at
      )
      select
        '${LOCAL_USER_ID}', p.id, jl.relevance_score, jl.match_reasons, jl.highlighted_skills,
        jl.status, jl.tailored_bullets, jl.cover_letter, jl.ai_generated, jl.fit_analysis,
        jl.fit_analyzed_at, jl.fetched_at
      from job_listings jl
      join postings p on p.url = jl.url
      order by (jl.status <> 'queued') desc, jl.relevance_score desc, jl.id
      on conflict (user_id, posting_id) do nothing;
    `,
  },
  {
    label: "postings id sequence",
    sql: `
      select setval(
        pg_get_serial_sequence('postings', 'id'),
        greatest((select coalesce(max(id), 0) from postings), 1),
        (select count(*) > 0 from postings)
      );
    `,
  },
  {
    label: "profiles.user_id",
    sql: `
      alter table profiles add column if not exists user_id uuid;
      update profiles set user_id = '${LOCAL_USER_ID}' where user_id is null;
      alter table profiles alter column user_id set not null;
      do $$ begin
        if not exists (select 1 from pg_constraint where conname = 'profiles_user_id_unique') then
          alter table profiles add constraint profiles_user_id_unique unique (user_id);
        end if;
        if not exists (select 1 from pg_constraint where conname = 'profiles_user_id_users_id_fk') then
          alter table profiles add constraint profiles_user_id_users_id_fk
            foreign key (user_id) references users(id) on delete cascade;
        end if;
      end $$;
    `,
  },
  {
    label: "documents.user_id",
    sql: `
      alter table documents add column if not exists user_id uuid;
      update documents set user_id = '${LOCAL_USER_ID}' where user_id is null;
      alter table documents alter column user_id set not null;
      create unique index if not exists documents_user_id_type_idx on documents(user_id, type);
      do $$ begin
        -- Replaced by the composite (user_id, type) index above: a document
        -- type is unique per account now, not platform-wide.
        if exists (select 1 from pg_constraint where conname = 'documents_type_unique') then
          alter table documents drop constraint documents_type_unique;
        end if;
        if not exists (select 1 from pg_constraint where conname = 'documents_user_id_users_id_fk') then
          alter table documents add constraint documents_user_id_users_id_fk
            foreign key (user_id) references users(id) on delete cascade;
        end if;
      end $$;
    `,
  },
  {
    label: "applications.user_id + job_id -> postings",
    sql: `
      alter table applications add column if not exists user_id uuid;
      update applications set user_id = '${LOCAL_USER_ID}' where user_id is null;
      alter table applications alter column user_id set not null;
      alter table applications alter column job_id type bigint;
      create index if not exists applications_user_id_idx on applications(user_id);
      do $$ begin
        if not exists (select 1 from pg_constraint where conname = 'applications_user_id_users_id_fk') then
          alter table applications add constraint applications_user_id_users_id_fk
            foreign key (user_id) references users(id) on delete cascade;
        end if;
        if exists (select 1 from pg_constraint where conname = 'applications_job_id_job_listings_id_fk') then
          alter table applications drop constraint applications_job_id_job_listings_id_fk;
        end if;
        if not exists (select 1 from pg_constraint where conname = 'applications_job_id_postings_id_fk') then
          alter table applications add constraint applications_job_id_postings_id_fk
            foreign key (job_id) references postings(id);
        end if;
      end $$;
    `,
  },
  {
    // After applications.user_id exists, so the brief can inherit its
    // tenant from the application it belongs to.
    label: "interview_briefs.user_id",
    sql: `
      alter table interview_briefs add column if not exists user_id uuid;
      update interview_briefs b
      set user_id = coalesce(
        (select a.user_id from applications a where a.id = b.application_id),
        '${LOCAL_USER_ID}'
      )
      where b.user_id is null;
      alter table interview_briefs alter column user_id set not null;
      do $$ begin
        if not exists (select 1 from pg_constraint where conname = 'interview_briefs_user_id_users_id_fk') then
          alter table interview_briefs add constraint interview_briefs_user_id_users_id_fk
            foreign key (user_id) references users(id) on delete cascade;
        end if;
      end $$;
    `,
  },
];

type Counts = Record<string, number>;

async function readCounts(
  client: { query: (text: string) => Promise<{ rows: Array<Record<string, unknown>> }> },
): Promise<Counts> {
  const { rows } = await client.query(`
    select
      (select count(*) from job_listings) as job_listings,
      (select count(*) from postings) as postings,
      (select count(*) from user_postings) as user_postings,
      (select count(*) from applications) as applications,
      (select count(*) from applications a
        where not exists (select 1 from postings p where p.id = a.job_id)) as dangling_applications,
      (select count(*) from (select url from job_listings group by url having count(*) > 1) d)
        as duplicate_urls
  `);
  const row = rows[0] ?? {};
  return Object.fromEntries(
    Object.entries(row).map(([key, value]) => [key, Number(value)]),
  );
}

async function main(): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("begin");

    for (const statement of STATEMENTS) {
      process.stdout.write(`  ${statement.label} ... `);
      await client.query(statement.sql);
      process.stdout.write("ok\n");
    }

    const after = await readCounts(client);

    // Post-migration assertions, exactly the reconciliation the architecture
    // doc asks for. A failure rolls the whole thing back.
    const problems: string[] = [];
    if (after["dangling_applications"] !== 0) {
      problems.push(
        `${after["dangling_applications"]} applications point at a job_id with no posting`,
      );
    }
    const expectedPostings =
      (after["job_listings"] ?? 0) === 0
        ? after["postings"]
        : (after["job_listings"] ?? 0) - (after["duplicate_urls"] ?? 0);
    if (after["postings"] !== expectedPostings) {
      problems.push(
        `postings=${after["postings"]} but job_listings minus url duplicates is ${expectedPostings}`,
      );
    }
    if ((after["user_postings"] ?? 0) < (after["postings"] ?? 0)) {
      problems.push(
        `user_postings=${after["user_postings"]} is short of postings=${after["postings"]}`,
      );
    }

    console.log("\nCounts after migration:");
    for (const [key, value] of Object.entries(after)) console.log(`  ${key}: ${value}`);

    if (problems.length > 0) {
      await client.query("rollback");
      console.error("\nReconciliation failed, rolled back:");
      for (const problem of problems) console.error(`  - ${problem}`);
      process.exitCode = 1;
      return;
    }

    if (dryRun) {
      await client.query("rollback");
      console.log("\nDry run: rolled back, nothing was changed.");
      return;
    }

    await client.query("commit");
    console.log("\nMigration applied.");
  } catch (err) {
    await client.query("rollback").catch(() => undefined);
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

await main();
