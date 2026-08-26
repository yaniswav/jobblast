# Docker: running JobBlast in SaaS mode (prod-like, local)

This is the multi-tenant stack (`JOBBLAST_MODE=saas`, docs/SAAS-ARCHITECTURE.md):
email + password accounts, invite-only registration, one Postgres, one Caddy
reverse proxy in front. It runs the same images on your own machine now
(Docker Desktop) and on a real VPS later - only the domain and TLS change
(lot F).

This is **not** the self-hosted, single-user JobBlast covered by
`README.md` / `docs/TUTORIAL.md`. If you just want your own personal
JobBlast, use that instead - it needs no Docker image build and no
invite codes. The self-hosted dev Postgres (`docker-compose.yml` at the
repo root, container `jobblast-pg`, port 5432) is completely separate from
everything below and is never touched by it.

## Layout

```
Dockerfile                     multi-stage build (repo root)
.dockerignore
deploy/saas/compose.yaml       the stack: db, migrate, app, caddy
deploy/saas/Caddyfile
deploy/saas/.env.docker.example
deploy/saas/.env.docker        you create this - gitignored, real secrets
```

All commands below are run from the repo root.

## 1. First-time setup

```bash
cp deploy/saas/.env.docker.example deploy/saas/.env.docker
```

Edit `deploy/saas/.env.docker` and fill in:

- `POSTGRES_PASSWORD` - `openssl rand -base64 24`
- `JOBBLAST_MASTER_KEY` - `openssl rand -base64 32` (encrypts every
  account's BYOK AI credentials; losing it makes them permanently
  undecryptable - keep it somewhere safe outside the repo)
- `APP_ORIGIN` - leave the default (`http://localhost:8080`) unless you
  changed the Caddy host port below

`SESSION_COOKIE_SECURE=0` is already set in the example file. That is
correct for this local stack: Caddy serves plain HTTP here (see "TLS" at
the bottom), so a Secure cookie would never make it back to the server.
Everything else in the file is optional - see the comments inline.

## 2. Build and start

```bash
docker compose -f deploy/saas/compose.yaml --env-file deploy/saas/.env.docker up -d --build
```

This builds the image (`jobblast-saas:local`), starts Postgres, waits for
its healthcheck, runs the one-shot `migrate` service (applies the Drizzle
schema - `drizzle-kit push --force`, so the `jobs` table the queue worker
polls on boot exists before `app` starts), then starts `app` and `caddy`.
First build takes a couple of minutes; `docker compose ... ps` should settle
with `db`, `app` healthy and `caddy` running.

Open **http://localhost:8080/** - you should see the login screen. Registration
is invite-only (see next step); there is no open signup form.

## 3. Create an invite code

```bash
docker compose -f deploy/saas/compose.yaml --env-file deploy/saas/.env.docker \
  exec app pnpm run invite
docker compose -f deploy/saas/compose.yaml --env-file deploy/saas/.env.docker \
  exec app pnpm run invite -- --uses 5 --days 30 --note "beta wave 1"
```

Prints the code to stdout (e.g. `60C1-KW41-VTH1`). Use it once on the
register screen (or `POST /api/auth/register`). Codes are single-use by
default; `--uses N` allows more, `--days N` sets an expiry.

## 4. Logs

```bash
docker compose -f deploy/saas/compose.yaml --env-file deploy/saas/.env.docker logs -f app
docker compose -f deploy/saas/compose.yaml --env-file deploy/saas/.env.docker logs -f caddy
docker compose -f deploy/saas/compose.yaml --env-file deploy/saas/.env.docker logs migrate
```

`app` logs structured JSON (pino) to stdout; each container's own logs are
capped at 10 MB x 3 files (`json-file` logging driver in compose.yaml) so a
noisy loop cannot fill the host's disk.

## 5. Stopping, restarting, cleaning up

```bash
docker compose -f deploy/saas/compose.yaml --env-file deploy/saas/.env.docker stop app     # graceful: SIGTERM, worker stops, server closes
docker compose -f deploy/saas/compose.yaml --env-file deploy/saas/.env.docker restart app   # same, then starts again
docker compose -f deploy/saas/compose.yaml --env-file deploy/saas/.env.docker down          # stops everything, keeps volumes (your data)
docker compose -f deploy/saas/compose.yaml --env-file deploy/saas/.env.docker down -v       # also deletes the volumes - irreversible
```

`app` handles `SIGTERM`/`SIGINT` itself (`artifacts/api-server/src/index.ts`):
it stops the queue worker's timers and closes the HTTP server before
exiting, so `docker stop`/`restart`/`down` do not leave rows stuck at
`status = 'running'` in the `jobs` table. Without that hook, a job that was
mid-poll when the container died would sit `running` for up to 20 minutes
(`LEASE_MS` in `lib/queue/store.ts`) before the next process reclaimed it -
harmless once, a real problem after every redeploy.

## 6. Single replica - do not scale `app`

`app` caches per-process: the AI provider cache (BYOK credentials,
`docs/SAAS-ARCHITECTURE.md` section 5) and the queue worker's in-memory
timers (section 6) both assume exactly one instance. Do not add
`deploy: replicas:` (or otherwise run two `app` containers against the same
database) - the fairness/queue design and the provider cache are both built
on "one process". Scale vertically (more CPU/RAM to the one container) if
you need more headroom.

## 7. Applying a schema change later

The `migrate` service runs `drizzle-kit push --force` non-interactively -
there is no TTY in an automated `up` to answer drizzle-kit's confirmation
prompt, and `--force` is safe against a fresh or already-matching database.
Before pushing a schema change that could be destructive against real data
(a column type change, a dropped column), review it interactively first:

```bash
docker compose -f deploy/saas/compose.yaml --env-file deploy/saas/.env.docker \
  exec -it app pnpm --filter @workspace/db run push
```

Answer the prompt, then redeploy normally (`up -d --build`) - the `migrate`
service's own `push --force` run will find nothing left to change.

## 8. Backups

Two things need backing up: the database and `data/` (uploaded CV / cover
letter PDFs, on the `jobblast-saas-app-data` volume).

```bash
# Database dump
docker exec jobblast-saas-db pg_dump -U postgres -Fc jobblast > backup-db-$(date +%F).dump

# data/ volume
docker run --rm -v jobblast-saas-app-data:/data -v "$PWD:/out" alpine \
  tar czf /out/backup-files-$(date +%F).tgz -C /data .
```

Restore, into a **scratch** database first to confirm the dump is good
before ever pointing it at anything real:

```bash
docker exec -i jobblast-saas-db pg_restore -U postgres -d jobblast --clean --if-exists < backup-db-2026-08-26.dump

docker run --rm -v jobblast-saas-app-data:/data -v "$PWD:/in" alpine \
  sh -c "cd /data && tar xzf /in/backup-files-2026-08-26.tgz"
```

An untested backup is a hypothesis, not a backup - restore the database dump
into a scratch container at least once before relying on it. Automating
this on a schedule (host cron / a Windows scheduled task) and pruning old
backups is lot F.

## 9. Rotating the BYOK master key

`JOBBLAST_MASTER_KEY` encrypts every account's BYOK AI provider credentials
(docs/SAAS-ARCHITECTURE.md section 5). If it leaks, or on a yearly schedule,
rotate it:

1. Generate a new one: `openssl rand -base64 32`.
2. In `deploy/saas/.env.docker`, move the current value of
   `JOBBLAST_MASTER_KEY` into a new `JOBBLAST_MASTER_KEY_PREVIOUS` line, then
   set `JOBBLAST_MASTER_KEY` to the new value.
3. Run the rotation script BEFORE restarting `app` with the new env - it
   needs both keys to re-encrypt every row:

   ```bash
   docker compose -f deploy/saas/compose.yaml --env-file deploy/saas/.env.docker \
     exec app pnpm run rotate-byok
   # review the dry-run output, then:
   docker compose -f deploy/saas/compose.yaml --env-file deploy/saas/.env.docker \
     exec app pnpm run rotate-byok -- --apply
   ```

   Dry run by default, reports what it would change and writes nothing;
   `--apply` performs the rotation. It is idempotent - re-running it (or
   running it on a table that is only partially rotated) is safe, since each
   row is skipped once it decrypts under the current key.
4. Restart `app` (`docker compose ... restart app`) so it picks up the new
   `.env.docker`. Remove `JOBBLAST_MASTER_KEY_PREVIOUS` once you have
   confirmed accounts can still test their saved keys from Settings.

Losing the master key without a rotation makes every stored BYOK credential
permanently undecryptable - accounts would need to re-enter their key.

## 10. Quotas, hygiene jobs and the Privacy page

**Quotas** (docs/SAAS-ARCHITECTURE.md section 5): daily per-account caps on
AI job kinds, checked before every provider call so a runaway loop never
runs up an account's own metered bill. Defaults are 40 cover letters, 60 fit
analyses and 5 interview briefs per day; override with
`JOBBLAST_QUOTA_TAILOR_PER_DAY` / `_FIT_PER_DAY` / `_BRIEF_PER_DAY`, or set
one to `0` to disable it. Going over a cap is never an error: a letter
request gets an immediate "try again tomorrow" response, and the nightly fit
/ brief passes simply defer the rest of their batch to the next run.
Selfhosted is always unlimited.

**Hygiene jobs**: two platform-wide, daily jobs run through the same queue
as everything else - `sessions.sweep` (deletes expired session rows) and
`postings.prune` (deletes shared postings nobody's queue references,
older than `JOBBLAST_POSTING_RETENTION_DAYS`, default 90). Both are saas
only: the queue worker itself never starts in selfhosted, which also never
creates a session row in the first place (no login screen).

**Privacy page**: `GET /api/legal` (linked from the login screen, the
sidebar and Settings) reports the operator identity from the
`JOBBLAST_LEGAL_*` env vars above, plus the current retention window and
quota caps, so the page never drifts from the real configuration. Leaving
`JOBBLAST_LEGAL_OPERATOR` unset makes it report itself as "not configured"
rather than a page full of blanks - fill it in before inviting anyone
outside your own testing.

## 11. TLS / a real domain

This local stack runs Caddy on plain HTTP (`deploy/saas/Caddyfile`,
`{$JOBBLAST_DOMAIN:http://localhost}`) mapped to `localhost:8080` - there is
no certificate to manage for a Docker Desktop smoke test. Setting
`JOBBLAST_DOMAIN` to a real domain name (no scheme) in `.env.docker` and
publishing 80/443 instead of 8080 turns Caddy's automatic HTTPS on with no
other change to the Caddyfile; that, plus a real place to run this stack,
is lot F. `SESSION_COOKIE_SECURE` should also come back to its default
(remove the `=0` override, or set it to `1`) once there is real TLS in
front - a Secure cookie over plain HTTP is silently dropped by the browser.

## Image details

Three-stage build (see the comments at the top of `Dockerfile`):

1. **build** - full pnpm workspace install, `pnpm run build` (typecheck,
   the esbuild api-server bundle, the Vite frontend build).
2. **prune** - same filesystem, every `node_modules` removed, every
   `package.json` and both build outputs kept.
3. **runtime** - fresh `node:24-slim`, a narrower `pnpm install` scoped to
   just `@workspace/api-server` (which pulls in `pdfkit` and
   `@node-rs/argon2`, the two packages esbuild leaves external - see
   `artifacts/api-server/build.mjs`), `@workspace/db` (`drizzle-kit push`)
   and `@workspace/scripts` (`pnpm run invite`) - not the frontend's build
   tooling. Runs as a non-root user (`jobblast`, uid 10001).

The repo's `artifacts/api-server` / `artifacts/jobblast` sibling layout is
kept as-is inside the image, so the app's existing relative static-file
lookup and its `data/` path resolution both keep working unchanged - no
source change was needed for either.

Built image size: **about 660 MB**. That is real workspace tooling
(`drizzle-kit`, `tsx`, `esbuild`) kept in on purpose so the two admin
commands above work via `docker exec` without a second image; the frontend's
own build dependencies (Vite, Tailwind, the component library, vitest) are
not in it.
