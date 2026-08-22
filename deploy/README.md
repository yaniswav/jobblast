# Running JobBlast in local "production"

This folder has everything needed to run JobBlast permanently on a machine
you own - no cloud, no hosting cost (\$0) - surviving reboots, on Windows,
Linux, or macOS.

## Principle

A single Node.js process (the Express API server) serves both:

- the API (`/api/...`),
- the already-built frontend (static Vite output, with an SPA fallback for
  client-side routes like `/review`).

Postgres runs separately (a Docker container, by default - see
`docker-compose.yml` at the repo root - or any Postgres instance you already
have). The API process does its own background work for as long as it runs:
job aggregation across every enabled source every 6 hours, and AI
tailoring (`claude -p`) every 30 minutes. Nothing else needs to run
continuously.

**App URL: http://localhost:5000/** (or whatever `PORT` is set to in `.env`).

## Files in this folder

| File | Role | Platform |
|---|---|---|
| `build.ps1` / `build.sh` | Production build: typecheck, build the frontend (`@workspace/jobblast`), build the API server (`@workspace/api-server`). | Windows / Linux+macOS |
| `start-jobblast.ps1` / `start-jobblast.sh` | Idempotent startup: makes sure Postgres is up, then starts the API (`SERVE_STATIC=1`) if it isn't already running. | Windows / Linux+macOS |
| `stop-jobblast.ps1` / `stop-jobblast.sh` | Stops the running API process. | Windows / Linux+macOS |
| `register-task.ps1` | Registers the Windows Scheduled Task `JobBlast` (auto-start at logon). | Windows only |
| `jobblast.service.example` | systemd unit template (auto-start on boot). | Linux only |
| `logs/jobblast.log` | Combined stdout+stderr of the running API. Rotated to `jobblast.log.old` once past 5MB. | all |

Both script sets do the same thing; use whichever matches your OS.

## Building

```powershell
# Windows
pwsh -NoProfile -ExecutionPolicy Bypass -File .\deploy\build.ps1
```

```bash
# Linux / macOS
bash deploy/build.sh
```

Rebuild after every code change, then restart (stop, then start).

## Starting / stopping manually

```powershell
# Windows
pwsh -NoProfile -ExecutionPolicy Bypass -File .\deploy\start-jobblast.ps1
pwsh -NoProfile -ExecutionPolicy Bypass -File .\deploy\stop-jobblast.ps1
```

```bash
# Linux / macOS
bash deploy/start-jobblast.sh
bash deploy/stop-jobblast.sh
```

Both start scripts are **idempotent**: if JobBlast is already running, they
print a message and exit 0 instead of starting a second instance.

## Viewing logs

```powershell
# Windows
Get-Content .\deploy\logs\jobblast.log -Tail 50 -Wait
```

```bash
# Linux / macOS
tail -f deploy/logs/jobblast.log
```

## Auto-start on boot / login

### Windows - Scheduled Task

```powershell
pwsh -NoProfile -ExecutionPolicy Bypass -File .\deploy\register-task.ps1
```

Creates/replaces a Scheduled Task named `JobBlast` that runs
`start-jobblast.ps1` (hidden window) at logon for the current user. Check it
with:

```powershell
Get-ScheduledTask -TaskName JobBlast
Get-ScheduledTaskInfo -TaskName JobBlast
```

If Docker Desktop is your Postgres, it needs to be set to launch at login
too (Docker Desktop → Settings → General → "Start Docker Desktop when you
log in") - a scheduled task alone can't launch a GUI app reliably without
that.

### Linux - systemd

```bash
sudo cp deploy/jobblast.service.example /etc/systemd/system/jobblast.service
sudo "$EDITOR" /etc/systemd/system/jobblast.service   # fill in WorkingDirectory / User / node path
sudo systemctl daemon-reload
sudo systemctl enable --now jobblast
journalctl -u jobblast -f                             # logs
```

If Postgres runs via `docker compose`, either give it its own
`restart: unless-stopped` (already set in the root `docker-compose.yml`) so
Docker's own daemon brings it back after a reboot, or add
`After=docker.service` / a dependency in the unit file.

### macOS - launchd

There's no bundled `.plist` here (systemd's job on Linux, Scheduled Tasks on
Windows - launchd is the macOS equivalent, but conventions vary enough by
setup that a one-size template isn't worth shipping). The short version:
create `~/Library/LaunchAgents/com.jobblast.plist` with a `ProgramArguments`
array equivalent to `deploy/start-jobblast.sh`'s `node` invocation (absolute
paths - launchd doesn't read your shell profile), a `RunAtLoad` key set to
`true`, and `StandardOutPath`/`StandardErrorPath` pointing at
`deploy/logs/jobblast.log`. Load it with
`launchctl load ~/Library/LaunchAgents/com.jobblast.plist`. If Postgres runs
via Docker Desktop, enable "Start Docker Desktop when you log in" the same
way as on Windows.

## Prerequisites / reminders

- Postgres must be reachable at the `DATABASE_URL` in `.env` before starting
  - the start scripts wait for it (via `docker exec ... pg_isready`) when
  it's the `jobblast-pg` Docker container, but won't wait for a Postgres
  instance managed some other way.
- `.env` must have `SERVE_STATIC=1` and a valid `PORT` / `DATABASE_URL` - do
  not remove them for a production run.
- **AI tailoring** (and AI Scout / Notion Inbox, if enabled) need the
  `claude` CLI installed and **logged in** under the account that runs the
  service/task. Without it, job aggregation keeps working but tailoring
  fails silently (check the logs) and postings get the fallback template
  letter instead of an AI-tailored one.
- After a reboot, the scheduled task / service brings everything back up
  automatically - give Docker a little time to finish starting before the
  Postgres wait loop times out (`start-jobblast.ps1` allows up to 120s for
  Docker itself, and both scripts allow up to 60s for Postgres to answer
  `pg_isready`).

## Advanced: scheduled Claude routines

For the optional cloud-scheduled routines that keep the review queue fed
even while your machine is off (a "Cloud Scout" that drops postings into a
Notion inbox, a Gmail morning-digest summary, a local "briefing" task) -
including generic, copy-pasteable prompts - see **`docs/TUTORIAL.md`**
("Advanced options", English) or **`docs/TUTORIEL.md`** ("Options
avancées", French).
