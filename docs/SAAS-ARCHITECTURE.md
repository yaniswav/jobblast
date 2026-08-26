# JobBlast v0.3: SaaS architecture

Status: proposal, not implemented. Target: one codebase, two modes.

The plan for turning today's single-user JobBlast into a multi-tenant beta
without regressing the self-hosted product. Opinionated on purpose: one
recommendation per topic, alternatives kept to a line so a future reader
knows what was rejected. Read alongside `README.md`, `docs/CONFIG.md`,
`deploy/README.md`.

## Table of contents

0. [Decision summary](#0-decision-summary)
1. [Two modes from one codebase](#1-two-modes-from-one-codebase)
2. [Authentication](#2-authentication)
3. [Multi-tenant data model](#3-multi-tenant-data-model)
4. [Isolation](#4-isolation)
5. [BYOK: per-user AI credentials](#5-byok-per-user-ai-credentials)
6. [Background work for many users](#6-background-work-for-many-users)
7. [Deployment shape](#7-deployment-shape)
8. [Security and GDPR minimum for the beta](#8-security-and-gdpr-minimum-for-the-beta)
9. [Migration plan (lots B to E)](#9-migration-plan-lots-b-to-e)
10. [Capability matrix](#10-capability-matrix)
11. [Open questions for the owner](#11-open-questions-for-the-owner)

---

## 0. Decision summary

| # | Topic | Decision | Rejected |
|---|---|---|---|
| 1 | Mode switch | `JOBBLAST_MODE=selfhosted` (default) or `saas`, read once in `lib/mode.ts` | A separate SaaS fork or branch |
| 2 | Auth | Email + password (argon2id), opaque server-side sessions in Postgres, HttpOnly cookie, rolling expiry | OAuth (Google review burden), magic links (email becomes a hard dependency for every login) |
| 3 | CSRF | `SameSite=Lax` plus a strict `Origin` / `Sec-Fetch-Site` check on unsafe methods | Double-submit token (plumbing through the generated API client) |
| 4 | Schema shape | One schema for both modes; self-hosted is a single implicit user row | Mode-conditional schema, leaving the SaaS path untested locally |
| 5 | Postings | Shared platform-wide `postings` pool plus a per-user `user_postings` join | Duplicating every posting row per user |
| 6 | Config storage | `user_settings.config jsonb`, validated by the existing `JobBlastConfigSchema`, behind the existing `config-store.ts` seam | A second config schema for SaaS |
| 7 | Config resolution | `AsyncLocalStorage` request/job context, fail-closed in `saas` | Threading `userId` through every `loadConfig()` caller |
| 8 | DB scoping | Explicit `userId` first argument in a new `lib/repo/` layer, enforced by a source-grep test | Relying on ambient context for queries too |
| 9 | BYOK crypto | AES-256-GCM from Node's built-in `crypto`, key from `JOBBLAST_MASTER_KEY`, AAD bound to user and provider | libsodium sealed box (native module, fights the esbuild bundle) |
| 10 | Queue | Hand-rolled Postgres `jobs` table with per-user fairness | pg-boss (own schema, own migrations, no fairness) |
| 11 | AI scheduling | Fit analysis batched nightly, cover letters strictly on demand | Eager tailoring, which spends the user's own money on letters they never open |
| 12 | Deployment | Docker Compose: app + postgres + caddy, same images on Windows now and a Linux VPS later | Any cloud-managed service |

---

## 1. Two modes from one codebase

One environment variable, read once:

```ts
// artifacts/api-server/src/lib/mode.ts
export const MODE = process.env["JOBBLAST_MODE"] === "saas" ? "saas" : "selfhosted";
export const IS_SAAS = MODE === "saas";
```

Rules that keep self-hosted safe:

- **Default is `selfhosted`.** An unset variable, a typo, or an old `.env`
  all resolve to today's behavior. Never `saas` by accident.
- **Mode is checked in as few places as possible**: auth middleware,
  config-store backend selection, provider construction, job enqueueing, and
  the startup preflight. Route handlers never branch on it.
- **Self-hosted is a real tenant, not a special case.** A fixed local user
  (`00000000-0000-0000-0000-000000000001`) is seeded on first boot and a
  mode-gated middleware injects it as `req.user`. Every route, repository
  call and queue job is therefore written once, for the multi-tenant shape,
  and exercised daily by the owner's own install: the strongest guarantee
  available that the SaaS path does not rot.
- **SaaS adds a startup preflight** refusing to boot without
  `JOBBLAST_MASTER_KEY`, `APP_ORIGIN` and a reachable SMTP relay, in the
  same fail-fast spirit as `loadConfig()`.

Everything CLI-dependent (AI Scout, Notion Inbox, Gmail sync, and the three
CLI providers) stays self-hosted-only in v0.3, see
[section 10](#10-capability-matrix).

---

## 2. Authentication

**Recommendation: email plus password, argon2id, opaque server-side
sessions in Postgres.**

**Hashing.** argon2id, memoryCost 19456 KiB, timeCost 2, parallelism 1 (the
OWASP baseline). Minimum 12 characters, no composition rules, checked
against a small embedded list of the 1000 most common passwords. Note
`argon2` is already in the esbuild `external` list in `build.mjs`, so the
native module survives bundling.

**Sessions.** Opaque 256-bit tokens, not JWTs: a row is the source of truth,
so logout, "sign out everywhere" and account deletion are a `DELETE` rather
than a revocation-list problem. The token travels in an HttpOnly, `Secure`,
`SameSite=Lax` cookie named `jb_session`; the database stores only
`sha256(token)`, so a leaked dump does not hand over live sessions.

```
sessions(id uuid pk, user_id uuid not null references users(id) on delete cascade,
         token_hash bytea not null unique, created_at timestamptz, last_seen_at timestamptz,
         expires_at timestamptz not null, user_agent text, ip_hash bytea)
```

Rolling expiry: absolute lifetime 30 days, idle timeout 14 days.
`last_seen_at` is refreshed at most once every 10 minutes (so a busy tab
does not write on every request) and `expires_at` moves to
`min(created_at + 30d, now + 14d)`. Expired rows go in the daily
maintenance job.

**CSRF.** `SameSite=Lax` already blocks cross-site form posts. On top,
middleware rejects any `POST`/`PUT`/`PATCH`/`DELETE` whose `Origin` is
absent or does not match `APP_ORIGIN`, also accepting
`Sec-Fetch-Site: same-origin`. Two dozen lines, no token plumbing through
the orval-generated client, testable as a pure predicate.

**Rate limiting.** `express-rate-limit`, default in-memory store (v0.3 is
one process):

| Route | Limit |
|---|---|
| `POST /auth/login` | 10 / 15 min per IP, 5 / 15 min per email |
| `POST /auth/register` | 5 / hour per IP |
| `POST /auth/password-reset` | 3 / hour per IP and per email |
| everything else under `/api` | 300 / 15 min per session |

Failed logins return a constant-time generic error and never reveal whether
the address exists.

**Password reset.** Single-use 256-bit token, hashed at rest, 30-minute TTL,
invalidated on use and on any password change. Send it through **an SMTP
relay with a free tier, via `nodemailer`**: Resend (3000/month) or Brevo
(300/day). Both are plain SMTP, so config stays provider-agnostic
(`SMTP_HOST`/`PORT`/`USER`/`PASS`/`FROM`) and a self-hoster can point it
anywhere. Do not run your own MTA: mail from a residential IP or a fresh
small VPS lands in spam, and a beta where resets silently fail is worse than
no reset. `nodemailer` is already in the esbuild externals.

**Why not OAuth or magic links.** OAuth (Google) needs a published privacy
policy URL, a verified consent screen and a review cycle before it works for
anyone outside a test list: a hard dependency on a third party's review
queue for a free beta. Magic links remove password storage but promote email
from "needed once, for reset" to "needed for every login", so one
spam-filtered message is a locked-out user with no fallback. Both stay
additive in v0.4 on the same `sessions` table: OAuth needs two columns on
`users` and a second login route, magic links need one token table.

---

## 3. Multi-tenant data model

### 3.1 New and changed tables

```
users(id uuid pk, email citext not null unique, password_hash text not null,
      email_verified boolean, display_name text, locale text,
      status text default 'active', created_at timestamptz, last_login_at timestamptz)

user_settings(user_id uuid pk references users(id) on delete cascade,
              config jsonb not null default '{}',   -- same shape as jobblast.config.json
              updated_at timestamptz)
```

`profiles`, `applications` and `documents` each gain
`user_id uuid not null references users(id) on delete cascade`, and their
uniqueness constraints become composite: `unique(user_id)` on `profiles`,
`unique(user_id, type)` on `documents` (replacing today's `unique(type)`).
`interview_briefs` inherits its tenant through `application_id` but gets a
denormalized `user_id` anyway, so the queue can scope and quota brief
generation without a join.

### 3.2 The key question: shared pool or per-user duplication

Sources return roughly 1500 raw postings per cycle, four cycles a day. After
scoring, thresholding and dedup, one user keeps 50 to 150 rows a day. The
question is what happens to the other 1350.

**Recommendation: a shared `postings` pool plus a per-user `user_postings`
join.**

```
postings(id bigserial pk, url text not null unique, source text, title text, company text,
         company_initials text, location text, work_mode text, description text,
         posted_date date, salary_range text,
         title_company_key text not null,     -- normalized + indexed: replaces today's full-table soft dedup
         first_seen_at timestamptz, last_seen_at timestamptz)

user_postings(user_id uuid references users(id) on delete cascade,
              posting_id bigint references postings(id) on delete cascade,
              relevance_score integer, match_reasons text[], highlighted_skills text[],
              status text default 'queued', tailored_bullets text[], cover_letter text,
              ai_generated boolean, fit_analysis jsonb, fit_analyzed_at timestamptz,
              created_at timestamptz, primary key (user_id, posting_id))
```

Indexes that matter: `postings(title_company_key)`, `postings(first_seen_at)`,
`user_postings(user_id, status, relevance_score desc)`.

**Honest cost comparison at 100 users, 90-day retention.** The cost is
entirely in `description`, which averages 4 to 8 KB.

| | Duplicated rows | Shared pool |
|---|---|---|
| Posting text stored | 100 x 150/day x 90d x 6 KB, roughly 8 GB | union of unique postings, roughly 400k x 6 KB, roughly 2.4 GB, flat in user count |
| Per-user rows | same table, wide | 1.35M narrow rows, 1 to 2 KB each once letters exist |
| Growth in N users | linear in the expensive column | linear only in the cheap column |
| Read complexity | single table | one indexed join, everywhere |
| Dedup | per user; today's soft dedup already full-scans `title, company` on every refresh | platform-wide and indexed, strictly better |
| Refresh network cost | linear in users | linear in *distinct query signatures*, far fewer |

On a 4 GB VPS this is the difference between the hot working set fitting in
page cache and not. The join is a single indexed lookup and is nowhere near
the bottleneck.

**What "fetched once platform-wide" actually means.** Sources are not
uniformly shareable. RemoteOK, Remotive, Himalayas, Arbeitnow, TokyoDev and
japan-dev return identical output for everyone. Greenhouse and Lever take
only a board list, so fetch the union of every enabled board once. France
Travail (keywords, departements), Adzuna (queries, country, where) and 104
(queries, area codes) are query-parameterized: fetch per **query
signature**, `sha256(source + canonicalized params)`, not per user, so users
targeting "C++ in Paris" share one fetch.

The refresh job's unit of work is therefore a query signature, not a user.
Beta users cluster heavily, so signature count grows far slower than user
count, which also keeps the polite request volume promised in the README
honest.

**Migration path.** `job_listings` splits in one migration: `postings` takes
the content columns (dedup by `url`), `user_postings` takes the scoring,
status and AI columns with `user_id` set to the local user, and
`applications.job_id` is repointed at `postings.id`. This is the single
riskiest step in the plan (see [section 9](#9-migration-plan-lots-b-to-e)).

**If it turns out to be wrong**, the escape hatch is cheap in one direction
only: denormalizing the hot columns onto `user_postings` recovers
single-table read speed without touching the write path, whereas going from
duplicated rows back to a shared pool needs a full dedup pass over the fat
table. That asymmetry is the second reason to start shared.

### 3.3 Per-user config

`user_settings.config` holds exactly the shape `jobblast.config.json` holds
today, validated by the same `JobBlastConfigSchema`. `lib/config-store.ts`
already exists as the single choke point and its header comment anticipates
this swap; it grows two backends behind unchanged signatures:

- `selfhosted`: today's `jsonc-parser` surgical file edit, untouched.
- `saas`: read, merge, validate, write against `user_settings.config`. No
  formatting preservation needed, since no human reads that JSON.

Job-source keys follow **platform default with per-account override**:
`FRANCETRAVAIL_CLIENT_ID` and friends in the app environment are the
fallback; `user_settings.config.sources.*.credentials` (encrypted, same
mechanism as BYOK) overrides per account. A user with no override rides the
platform key, which is what makes a zero-setup beta possible.

---

## 4. Isolation

Three layers, because one is not enough.

**Layer 1: request context.** `requireUser` resolves the session cookie into
`req.user`; in `selfhosted` a mode-gated middleware injects the local user
instead. Both then run `userContext.run({ userId }, next)` using Node's
`AsyncLocalStorage`, so `loadConfig()` and the AI provider factory keep
their zero-argument signatures and resolve per user. This is the deliberate
compromise that avoids threading a parameter through fifteen deep call sites
in the source fetchers and PDF renderers.

The rule that makes it safe: **in `saas`, `loadConfig()` with no ambient
context throws.** Never a file, never a default, never another user's
settings. Fail closed, loudly, in development. In `selfhosted` an empty
context resolves to the file backend, exactly as today.

**Layer 2: explicit query scoping.** Ambient context is fine for read-only
configuration and not fine for database access, where a forgotten scope is a
data leak. A new `src/lib/repo/` module holds every query, and every
exported function takes `userId` first:

```ts
export async function listUserPostings(userId: string, filter: PostingFilter): Promise<UserPostingRow[]>
export async function getUserPosting(userId: string, postingId: number): Promise<UserPostingRow | null>
```

Route handlers import from `lib/repo/`, never from `@workspace/db`.
`getJobWithApplication`, `listJobsWithApplications` and `getApplications` in
`lib/jobblast-data.ts` move here and gain the parameter.

**Layer 3: an automated guard.** A pure-logic vitest file reads the source
text of `src/routes/` and `src/lib/repo/` and asserts that (1) no route file
imports `@workspace/db` or any `*Table` symbol, and (2) every exported async
function in `src/lib/repo/` names its first parameter `userId`. Roughly 35
lines, no ESLint setup, no new dependency, and it fails in CI the moment
someone adds a route that queries directly. Alternative: an ESLint
`no-restricted-imports` override scoped to `src/routes/`, equivalent but
adds an ESLint config this repo does not have.

**Files on disk.** `DOCUMENTS_DIR` becomes per user:

```
data/users/<uuid>/documents/cv.pdf
data/users/<uuid>/documents/cover_letter.pdf
data/users/<uuid>/state/gmail-sync-last-run.txt      (selfhosted only)
```

One helper owns the path and validates the id before joining:

```ts
export function userDataDir(userId: string): string {
  if (!UUID_RE.test(userId)) throw new Error("Refusing to build a data path from a non-UUID user id");
  return path.join(REPO_ROOT, "data", "users", userId);
}
```

Because ids are validated UUIDs, traversal through the id is impossible and
a directory listing does not leak an ordered user count the way serial ids
would.

**Document and PDF access control.** No file path ever crosses the API
boundary. `GET /documents/:type/file` looks the row up with
`getDocument(userId, type)` and streams `row.path`; a request for another
user's document finds no row and gets a 404, never a 403 (which would
confirm existence). The cover-letter and interview-brief PDFs render from
rows already scoped by `userId` and inherit the same guarantee. No signed
URLs are needed in v0.3, since every byte is served through the
session-authenticated API.

---

## 5. BYOK: per-user AI credentials

In `saas`, only `anthropic-api` and `openai-compatible` are selectable, and
the key belongs to the user.

**Encryption: AES-256-GCM using Node's built-in `crypto`.** No new
dependency, nothing native, nothing fighting the esbuild externals list.
libsodium's sealed box is a fine primitive but arrives as `sodium-native`,
for no security gain over AEAD with a correctly derived key.

```
user_ai_credentials(user_id uuid references users(id) on delete cascade, provider text,
                    key_version smallint, iv bytea, ciphertext bytea, auth_tag bytea,
                    hint text,             -- last 4 chars, for the UI
                    last_ok_at timestamptz, last_error text,
                    primary key (user_id, provider))
```

- Master key from `JOBBLAST_MASTER_KEY`, 32 bytes base64
  (`openssl rand -base64 32`). The app refuses to boot in `saas` without it.
- Per-user data key derived with HKDF-SHA256, salted with `user_id`. The
  master key never encrypts anything directly.
- **AAD is `${userId}:${provider}:${keyVersion}`.** A ciphertext copied from
  one user's row into another's fails authentication rather than decrypting.
  This detail is what turns "encrypted at rest" into real isolation.
- Plaintext exists only inside the provider call: never logged, never cached
  across requests, never written to disk.

**Rotation.** `key_version` plus a `JOBBLAST_MASTER_KEY_PREVIOUS` variable.
Decryption tries the row's version; `pnpm run rotate-byok` reads every row
with the old key, re-encrypts with the new one and bumps the version, one
user per transaction. Rotation is therefore a background operation with no
downtime and no big-bang. Run it if the key leaks, or annually.

**Never returned by the API.** `GET /settings` returns
`{ configured: true, hint: "4f2a", lastOkAt, lastError }` and nothing else.
No endpoint returns a key in any form to anyone, including the owner.
`POST /settings/ai/test` keeps working: it decrypts in memory, makes the
existing one-line test call, and records `last_ok_at` or `last_error`.

**Quotas.** BYOK means every letter costs the user real money, so the
platform protects them from a runaway loop. A
`usage_counters(user_id, day, kind, count)` table is incremented atomically
with `insert ... on conflict do update set count = count + 1 returning count`,
checked before the provider call and never after. Defaults, overridable per
user by the operator: `letter` 40/day, `fit` 60/day, `brief` 5/day
(self-hosted only in v0.3). Exceeding a cap is not an error: the job is
rescheduled for the next day and the UI says so. In `selfhosted` the caps
are unset, so behavior is unchanged.

**Failure isolation.** Today `lib/ai/provider.ts` holds `built`,
`disabledReason` and `startupLogged` at module scope. In a multi-tenant
process, one user's bad key would silently disable AI for everyone. This is
the most important correctness fix in the BYOK lot: the cache becomes a
bounded per-user LRU map and `disableAi()` becomes
`disableAiForUser(userId, reason)`, writing `last_error` on the credential
row so the user sees it in Settings. A failure for user A never touches user
B. In `selfhosted` there is exactly one entry, so behavior is identical.

---

## 6. Background work for many users

**The problem with today's shape.** `src/index.ts` runs two `setInterval`
timers and a strictly sequential chain (tailor, fit, Gmail, briefs) so at
most one CLI call is ever in flight. That serialization is correct for a CLI
on one machine and completely wrong for `saas`, where calls are HTTPS
requests to different users' endpoints and are trivially parallelizable.

**Recommendation: a hand-rolled Postgres queue.**

```
jobs(id bigserial pk, kind text not null, user_id uuid,       -- null for platform-wide jobs
     payload jsonb, dedupe_key text, status text default 'pending',
     run_at timestamptz, attempts smallint, max_attempts smallint default 3,
     locked_by text, locked_at timestamptz, last_error text, created_at timestamptz);
create unique index jobs_dedupe on jobs(dedupe_key) where status = 'pending';
create index jobs_claim on jobs(status, run_at) where status = 'pending';
```

Rejected: **pg-boss**. A good library, but it installs and migrates its own
schema, runs its own maintenance loop, brings a second scheduling model (its
cron, singletons, archival) to learn and debug, and does not give per-user
fairness, which is the one property this system actually needs. The
hand-rolled version is roughly 120 lines against a Postgres already running,
and fairness is three lines of SQL. Revisit pg-boss if the queue module ever
passes 200 lines.

**Claiming, with fairness built in.** `SELECT DISTINCT ON (user_id)` yields
at most one job per user per round, so a user with 200 queued letters cannot
starve a user with one:

```sql
with claimable as (
  select distinct on (user_id) id from jobs
  where status = 'pending' and run_at <= now()
  order by user_id, run_at asc
  for update skip locked
)
update jobs set status = 'running', locked_by = $1, locked_at = now(), attempts = attempts + 1
where id in (select id from claimable order by random() limit $2)
returning *;
```

| Cap | selfhosted | saas |
|---|---|---|
| Global worker concurrency | 1 | 4 (`JOBBLAST_WORKER_CONCURRENCY`) |
| In-flight jobs per user | 1 | 1 |
| CLI-backed job kinds | enabled | never enqueued |

Global concurrency stays 1 in `selfhosted` so the existing "one CLI call at
a time" invariant, which exists because `claude -p` is expensive and the
machine is shared with its owner, survives untouched.

**Job kinds and scheduling.**

| kind | scope | when | cost |
|---|---|---|---|
| `postings.refresh` | per query signature | hourly ticker enqueues; dedupe key prevents pile-up | network only |
| `user.score` | per active user | after a refresh batch lands | CPU only, no AI |
| `user.fit` | per user | nightly, top 10 unanalyzed by score | 1 AI call each |
| `user.tailor` | per user | **on demand only** in saas | 1 AI call each |
| `postings.prune`, `sessions.sweep` | platform | daily | SQL only |
| `aiscout`, `notion`, `gmail`, `brief` | per user | selfhosted only | agent calls |

The shared refresh moves from 6 hours to **hourly**, because it is now
amortized across all users and each cycle covers fewer signatures.

**The one behavior change worth calling out.** In `selfhosted`, tailoring is
eager: every queued job gets a letter, because `claude-cli` costs nothing
marginal. In `saas` with BYOK it is on demand, generated when the user opens
that posting or clicks Prepare. Spending someone else's metered budget on
150 letters they will never read is not a defensible default, and it is also
the biggest single lever on cost per user. Fit analysis stays batched
because it is short and it is what makes the queue triageable.

**What happens at 10, 100 and 1000 users on a 4 GB VPS.**

| Users | Verdict | Binding constraint |
|---|---|---|
| 10 | Comfortable | Nothing. App roughly 400 MB RSS, Postgres roughly 600 MB, data under 5 GB. |
| 100 | Workable with care | `user_postings` reaches roughly 1.4M rows over 90 days. Needs the prune job, `shared_buffers=512MB`, `max_connections=30`, and letters kept on demand. Roughly 2.5 to 4 GB of Postgres data. Disk runs out before RAM. |
| 1000 | Does not fit | Not one thing: roughly 25 to 40 GB of data, 14M `user_postings` rows, and enough concurrent outbound AI calls that 4 workers become the bottleneck. Needs 8 to 16 GB, a separate data volume, and letters moved to their own table. |

**Plan the beta to stop at roughly 100 to 150 accounts**, with the cap in
code (a `count(*) from users` check at registration), not in a spreadsheet.

---

## 7. Deployment shape

`docker compose up -d` works identically on Docker Desktop for Windows today
and on a Linux VPS later, with the same images. No cloud-provider-specific
services anywhere.

### Dockerfile (multi-stage)

```dockerfile
FROM node:24-slim AS build
RUN corepack enable
WORKDIR /app
COPY . .
RUN pnpm install --frozen-lockfile && pnpm run build
RUN pnpm --filter @workspace/api-server deploy --prod --legacy /out \
 && cp -r artifacts/jobblast/dist /out/public

FROM node:24-slim AS runtime
ENV NODE_ENV=production SERVE_STATIC=1 PORT=5000
RUN useradd --system --uid 10001 jobblast
WORKDIR /app
COPY --from=build --chown=jobblast:jobblast /out ./
USER jobblast
EXPOSE 5000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD node -e "fetch('http://127.0.0.1:5000/api/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "--enable-source-maps", "dist/index.mjs"]
```

Two things the build must not get wrong: `pdfkit` is externalized in
`build.mjs` because it resolves its AFM font metrics at runtime, so it must
exist in the runtime `node_modules` (which `pnpm deploy --prod` handles);
and the static path `app.ts` resolves under `SERVE_STATIC=1` has to be
preserved or adjusted, since the container layout is flatter than the repo.

### Compose

**`db`**: `postgres:16`, password from `.env` (never the literal `postgres`
in `saas`), volume `pg-data`, the existing `pg_isready` healthcheck, and
**no host port published**, unlike today's dev compose. **`app`**: built
above, `depends_on: db (service_healthy)`, `env_file: .env`, volume
`app-data:/app/data`, `restart: unless-stopped`. **`caddy`**:
`caddy:2-alpine`, ports 80 and 443, volumes `caddy-data` (certificates, must
persist or you will hit ACME rate limits) and `caddy-config`.

One Caddyfile covers both environments:

```
{$JOBBLAST_DOMAIN:localhost} {
	encode zstd gzip
	reverse_proxy app:5000
}
```

Unset, it serves `https://localhost` with Caddy's own local CA, which is
exactly right on the Windows dev box. Set it to a real domain on the VPS and
Caddy provisions a Let's Encrypt certificate on first request, with no other
change. Caddy sets `X-Forwarded-For`, so Express needs
`app.set("trust proxy", 1)` or every rate limit keys on the proxy.

**Keep today's `docker-compose.yml` untouched** as the self-hosted dev
Postgres. The new stack lives in `deploy/saas/compose.yaml` so the two never
collide (`PG_CONTAINER_NAME` already anticipates coexistence).

### Environment, backups, logs

One `.env` next to the compose file, `chmod 600`, never in the image, never
committed. Required in `saas`: `JOBBLAST_MODE`, `DATABASE_URL`,
`JOBBLAST_MASTER_KEY`, `APP_ORIGIN`, `SESSION_COOKIE_SECURE`, the `SMTP_*`
group, and optionally the platform-default job-source keys. `.env.example`
grows a clearly separated "SaaS mode only" block so a self-hoster ignores it
at a glance. Two things need backing up, and only one is the database:

```bash
# host cron, 03:15 daily
docker exec jobblast-db pg_dump -U postgres -Fc jobblast > /backups/db-$(date +%F).dump
docker run --rm -v jobblast_app-data:/data -v /backups:/out alpine \
  tar czf /out/files-$(date +%F).tgz -C /data .
find /backups -mtime +14 -delete
```

Retention 14 daily plus a monthly copy pulled off the box. **Test the
restore once before the first external user**, into a scratch database. An
untested backup is a hypothesis.

pino already writes JSON to stdout in production and already redacts
`authorization`, `cookie` and `set-cookie`; the HTTP serializer in `app.ts`
already strips query strings. Add `req.body` and `*.apiKey` to the redact
list, and cap Docker's own logs (`json-file`, `max-size: 10m`,
`max-file: 3`) so a loop cannot fill the disk.

### Resource envelope for the beta

| Service | Memory limit | Notes |
|---|---|---|
| `app` | 768 MB | roughly 400 MB steady with 4 workers |
| `db` | 1.5 GB | `shared_buffers=512MB`, `work_mem=8MB`, `max_connections=30` |
| `caddy` | 128 MB | |
| headroom | roughly 1.5 GB | page cache, backups, the OS |

Fits a 4 GB / 2 vCPU VPS at the beta size defined above.

---

## 8. Security and GDPR minimum for the beta

**Privacy page outline** (static page at `/privacy`, linked from the footer
and from a required checkbox on the registration form):

1. Who runs this and how to reach them (see open question 2).
2. What is collected: email, password hash, profile (name, headline, target
   roles and locations, salary floor, master resume), uploaded CV and cover
   letter PDFs, application history, and an encrypted AI provider key if
   supplied.
3. Why: to run the service the user asked for. Legal basis: performance of a
   contract. No profiling, no advertising, no sale of data, no telemetry.
4. Where it goes: the job source APIs enabled on the account, and the AI
   provider whose key the user supplied, naming explicitly that resume text
   is sent to that provider to write letters.
5. Where it lives: one server, named country, plus a note that the AI
   provider may process outside the EU.
6. How long: while the account exists, plus 30 days of backup retention.
   Postings older than 90 days are pruned.
7. Rights: export, deletion, correction, each one click in Settings.
8. Cookies: exactly one, `jb_session`, strictly necessary, so no consent
   banner is needed.
9. Beta status: free, best-effort, no availability guarantee, and a
   commitment to email before any shutdown.

**Account deletion.** `DELETE /api/account`, confirmed by re-entering the
password. It deletes the `users` row (every `on delete cascade` above then
removes sessions, settings, credentials, profile, applications, documents,
briefs, `user_postings`, counters and pending jobs), recursively deletes
`data/users/<uuid>/`, and logs one line with the user id and no personal
data. Shared `postings` rows survive, correctly: they are public job
adverts, not personal data. Backups still hold the data for their retention
window; say so on the privacy page rather than pretending otherwise.

**Data export.** `GET /api/account/export.json` streams one JSON document:
the user record without the password hash, settings with the AI key redacted
to its hint, profile, applications, every `user_postings` row joined to its
posting, and the interview briefs. Documents are excluded and the response
links to the existing per-document endpoints, because base64-inlining two
5 MB PDFs into a JSON body helps nobody. No new dependency, no zip library.

**What is logged.** Method, path with query stripped, status, duration,
request id, and job outcomes. **Never**: request bodies, resume or letter
text, email addresses in the clear (hash them when a line needs to
correlate), or any redacted header. IP addresses are stored only as
`sha256(ip + salt)` on the session row, for abuse triage, and go away with
the session.

**Abuse mitigation.** In-app rate limits (section 2) are the primary control
and behave identically on Windows and on a VPS. On the VPS, add fail2ban
watching Caddy's access log for repeated 401s and 429s from one address,
banning for an hour.

**The EOL operating system.** The Debian 10 box must not host this. It left
even LTS support in mid-2024, so it gets no security updates for the kernel,
OpenSSL or the container runtime, and running a service holding other
people's resumes, email addresses and API keys on an unpatched OS is not a
risk trade-off, it is a defect. For v0.3, develop and run the beta under
Docker Desktop on the Windows machine. Before the first external signup,
move to a VPS on a supported LTS (Debian 13 or Ubuntu 24.04) with
unattended-upgrades on, SSH key-only, root login disabled, and only 22, 80
and 443 open. That decision can wait, but it must be made before, not after,
the first external user.

---

## 9. Migration plan (lots B to E)

Every step is one PR and ends with the same **self-hosted green checklist**:

- [ ] `pnpm run typecheck`, `pnpm test` and `pnpm run build` all pass
- [ ] Server boots with no `JOBBLAST_MODE` set and no new required variable
- [ ] Review queue lists postings; Approve creates an application
- [ ] One letter generates via `claude-cli`
- [ ] Settings page writes `jobblast.config.json` with a minimal diff
- [ ] An existing install's `data/` layout still works

### Lot B: mode plumbing and schema (no behavior change)

| Step | What | Risk |
|---|---|---|
| B1 | `lib/mode.ts`, startup preflight, `.env.example` SaaS block | low |
| B2 | `users` table, fixed local-user seed in `ensureJobBlastSeeded()` | low |
| B3 | `user_id` on `profiles`/`applications`/`documents`/`interview_briefs`, backfilled to the local user; composite uniques; one-time idempotent move of `data/` to `data/users/<local-uuid>/` | medium |
| B4 | **Split `job_listings` into `postings` + `user_postings`** | **high** |
| B5 | `lib/repo/` layer, routes rewired, the no-direct-db guard test | medium |

**B4 is the riskiest step in the plan**: it rewrites the table holding
everything the owner's own install has accumulated. Mitigations: a `pg_dump`
inside the migration script before the first `ALTER`; a dry-run mode
reporting the row counts it would produce; post-migration assertions that
`count(postings) + count(user_postings)` reconciles with the old
`count(job_listings)` and that every `applications.job_id` resolves; and a
rehearsal against a restored copy of the real database.

### Lot C: authentication

| Step | What | Risk |
|---|---|---|
| C1 | `sessions` table, argon2id helpers, `/auth/register`, `/auth/login`, `/auth/logout` in `openapi.yaml`, regenerated | medium |
| C2 | **Session middleware, mode-gated local-user injection, `requireUser` on every `/api` route** | **high** |
| C3 | Origin-check CSRF middleware, `express-rate-limit`, `trust proxy` | low |
| C4 | Password reset, `nodemailer` plus SMTP relay, token table | medium |
| C5 | Frontend login and register pages, 401 handling in `custom-fetch.ts`, account menu | medium |

**C2 is the second riskiest step**: a wrong default either locks the
self-hosted owner out of their own install or leaves a SaaS route
unauthenticated. Mitigation: apply the middleware once, at the router level
in `routes/index.ts`, with an explicit allowlist of public paths
(`/healthz`, the auth routes), never per route, plus a test asserting every
registered path is either allowlisted or behind `requireUser`. Run
`pnpm --filter @workspace/api-spec run codegen` after every contract change
in C1 and C5; do not hand-edit the generated files.

### Lot D: per-user config and BYOK

| Step | What | Risk |
|---|---|---|
| D1 | `user_settings`, `config-store.ts` SaaS backend, `AsyncLocalStorage` context, fail-closed rule | medium |
| D2 | **Per-user provider cache, `disableAiForUser`** | **high** |
| D3 | `user_ai_credentials`, AES-256-GCM helpers, write-only Settings UI, rotation script | medium |
| D4 | `usage_counters`, quota checks before every provider call | low |

**D2 is the third riskiest step**, because its failure mode is silent: a
missed module-level cache serves one user's config or key to another.
Mitigation: delete the module-level `built` / `disabledReason` variables
outright rather than adding a map alongside them, so the compiler finds
every reader.

### Lot E: queue and deployment

| Step | What | Risk |
|---|---|---|
| E1 | `jobs` table, claim query, worker loop, fairness selection | medium |
| E2 | Move the four passes onto job kinds; the ticker only enqueues | medium |
| E3 | **Shared refresh keyed by query signature; per-user `user.score` job** | **high** |
| E4 | Dockerfile, `deploy/saas/compose.yaml`, Caddyfile, healthchecks | low |
| E5 | Backup cron, prune job, privacy page, export and delete endpoints | low |

**E3 is risky** because wrong signature canonicalization either over-shares
(a user sees postings from another user's query, which is confusing but
harmless) or under-shares (everyone gets their own fetch and the polite
request budget is blown). Mitigation: the canonicalizer is a pure function
with a table-driven test, and the refresh job logs signature count per cycle
so a regression is one log line away.

### Test strategy

The existing suite is roughly 500 lines of pure-logic vitest across six
files: no database, no network, no CLI mocking (`vitest.config.ts` supplies
a fake `DATABASE_URL` precisely so nothing dials out). Everything below
holds that line and fits the +300 line budget:

| File | Lines | What is asserted |
|---|---|---|
| `lib/auth/password.test.ts` | 40 | argon2id roundtrip, wrong password rejected, hash carries the expected parameters |
| `lib/auth/session.test.ts` | 50 | token format and entropy; pure `nextExpiry(createdAt, lastSeenAt, now, policy)` for rolling, idle and absolute expiry |
| `lib/auth/csrf.test.ts` | 35 | table-driven `isRequestOriginAllowed(method, origin, secFetchSite, appOrigin)` |
| `lib/crypto/byok.test.ts` | 45 | encrypt/decrypt roundtrip, wrong AAD rejected, wrong key rejected, key-version selection |
| `lib/quotas.test.ts` | 35 | pure `checkQuota(used, cap, now)` including the day-rollover boundary |
| `lib/queue/fairness.test.ts` | 50 | pure `selectNextJobs(pending, inFlightByUser, caps)` is round-robin and respects both caps |
| `lib/scoping.test.ts` | 35 | the source-grep guard from [section 4](#4-isolation) |
| **Total** | **290** | |

The pattern is deliberate: every risky decision is extracted into a pure
function taking its inputs explicitly, so it is testable without a database,
and the impure shell around it (the SQL, the cookie, the HTTP call) stays
thin enough to read.

---

## 10. Capability matrix

Feature by mode by provider, as of v0.3.

| Feature | selfhosted `claude-cli` | selfhosted `codex-cli` | selfhosted `anthropic-api` / `openai-compatible` | selfhosted `ollama` / `lmstudio` | selfhosted `none` | **saas `anthropic-api` (BYOK)** | **saas `openai-compatible` (BYOK)** | **saas, no key** |
|---|---|---|---|---|---|---|---|---|
| Job aggregation, 11 sources | yes | yes | yes | yes | yes | yes, shared pool | yes, shared pool | yes, shared pool |
| Keyword scoring | yes | yes | yes | yes | yes | yes | yes | yes |
| Letters and bullets | AI | AI | AI | AI, local | template | AI, on demand, quota | AI, on demand, quota | template |
| Fit analysis | AI | AI | AI | AI, local | no | AI, nightly, quota | AI, nightly, quota | no |
| PDF export | yes | yes | yes | yes | yes | yes | yes | yes |
| Application tracker | yes | yes | yes | yes | yes | yes | yes | yes |
| Interview briefs | AI, web | AI, web | no | no | no | **no** | **no** | no |
| AI Scout | yes | yes | no | no | no | **no** | **no** | no |
| Notion Inbox | yes | via Notion MCP | no | no | no | **no** | **no** | no |
| Gmail sync | yes | no | no | no | no | **no** | **no** | no |
| Per-user source keys | n/a (`.env`) | n/a | n/a | n/a | n/a | yes, or platform default | yes, or platform default | yes, or platform default |
| Marginal AI cost | subscription | subscription | metered | free | none | user's key | user's key | none |

The four SaaS "no" rows all have one cause: those features need a
**tool-using agent**, and `getAgentProvider()` returns null for both API
providers (see the comments in `lib/ai/provider.ts`). They are blocked by
capability, not policy, and the fix is not a SaaS fix: it is wiring
Anthropic's server-side tools into `providers/anthropic-api.ts`, a v0.4 item
worth its own decision. Until then the SaaS Settings page hides those
toggles rather than showing them disabled with no explanation.

---

## 11. Open questions for the owner

1. **Domain and registrar.** Is there a domain for the beta, and who holds
   the DNS? This decides whether Caddy runs in ACME or local-CA mode from
   day one, and whether the privacy page can live at a stable URL before the
   first signup.

2. **Who is the data controller, legally?** Your own name and postal
   address, or an entity? GDPR requires a real, contactable identity on the
   privacy page, and a home address is the default answer for a solo
   project. If that is not acceptable, it changes whether the beta can be
   open at all or has to stay invite-only among people you already know.

3. **Retention after inactivity.** Should an account with no login for N
   months be deleted automatically, and if so at what N and with how much
   warning? It has to be on the privacy page from the start and is much
   harder to add later than to state now.

4. **BYOK mid-pass failure.** When a user's key starts being rejected, do we
   (a) fall back to template letters silently, mirroring today's self-hosted
   behavior, (b) stop and surface a banner in the app, or (c) also send one
   email? Option (b) is the recommendation, but (c) costs an email template
   and a "do not spam them daily" rule.

5. **Signup gating.** Open registration with a hard cap of roughly 100
   accounts, or invite codes? Invite codes are about 20 lines now (one
   table, one check at registration) and cannot be retrofitted painlessly
   once an open form has been shared.
