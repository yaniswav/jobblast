# Tutorial: installing and using JobBlast

French version: docs/TUTORIEL.md

Step-by-step guide for someone who has never used Node.js, Docker, or the
an AI CLI before. If you're already comfortable with those tools, the
`README.md` (Quick start) will be faster.

Everything you need is free: Postgres runs on your own machine (via
Docker), the job sources enabled by default need no key at all, and the
(optional) AI uses your existing Claude subscription instead of a
pay-per-use API key.

## Table of contents

1. [Install the prerequisites](#1-install-the-prerequisites)
2. [Clone and install the project](#2-clone-and-install-the-project)
3. [Copy the configuration files](#3-copy-the-configuration-files)
4. [Start the database](#4-start-the-database)
5. [Create the tables](#5-create-the-tables)
6. [Run the app in development mode](#6-run-the-app-in-development-mode)
7. [Fill in your profile](#7-fill-in-your-profile)
8. [Get free API keys](#8-get-free-api-keys)
9. [Adapt `jobblast.config.json` to your profile](#9-adapt-jobblastconfigjson-to-your-profile)
10. [Choose an AI provider (for AI letters)](#10-choose-an-ai-provider-for-ai-letters)
11. [Deploy in "local production"](#11-deploy-in-local-production)
12. [Daily usage routine](#12-daily-usage-routine)
13. [Advanced options](#13-advanced-options)
14. [Privacy](#14-privacy)
15. [FAQ / troubleshooting](#15-faq--troubleshooting)

---

## 1. Install the prerequisites

### Node.js (version 24 or later)

JobBlast uses a recent Node.js feature (`--env-file-if-exists`), so you
need Node **24 or higher**.

- Download it from [nodejs.org](https://nodejs.org/) (pick the "Current"
  version, not necessarily "LTS" if it's still below 24), or install it
  via a version manager
  ([nvm-windows](https://github.com/coreybutler/nvm-windows) on Windows,
  [nvm](https://github.com/nvm-sh/nvm) on macOS/Linux).
- Check the install:

  ```bash
  node -v
  ```

  You should see `v24.x.x` or higher.

### pnpm (version 10)

JobBlast is a monorepo managed with **pnpm**, not npm or yarn (the project
deliberately refuses to install with any other package manager).

```bash
corepack enable
corepack prepare pnpm@10 --activate
pnpm -v
```

(If `corepack` isn't available, install pnpm directly:
`npm install -g pnpm@10`.)

### Docker (for the Postgres database)

- **Windows / macOS**: install
  [Docker Desktop](https://www.docker.com/products/docker-desktop/),
  launch it once to finish the initial setup.
- **Linux**: install Docker Engine + the Compose plugin via your package
  manager (or follow the
  [official instructions](https://docs.docker.com/engine/install/)).

You don't have to use Docker: if you already have a Postgres 16 server
somewhere, skip straight to step 5 and point `DATABASE_URL` at it.

### Git

Needed to clone the repository. On Windows, install
[Git for Windows](https://git-scm.com/download/win) (it also provides
"Git Bash", handy for the commands in this tutorial).

---

## 2. Clone and install the project

```bash
git clone https://github.com/yaniswav/jobblast.git
cd jobblast
pnpm install
```

`pnpm install` downloads every dependency in the monorepo (frontend, API,
shared libraries). This can take a few minutes the first time.

---

## 3. Copy the configuration files

JobBlast keeps everything personal (identity, keys, scoring settings...)
out of the source tree, in three files that git **does not track** (see
`docs/CONFIG.md` for the details). One command creates all three at once
from their committed examples:

```bash
pnpm run setup
```

This command does nothing if the files already exist (safe to run again
after a `git pull`, for example when a new example file shows up). It
creates:

| File created | From | Content |
|---|---|---|
| `.env` | `.env.example` | Secrets and ports (database, API keys, server port) |
| `jobblast.config.json` | `jobblast.config.example.json` | Identity, scoring rules, enabled sources |
| `config/cover-letter-template.txt` | `config/cover-letter-template.example.txt` | Your template cover letter, used as a model by the AI |

You'll edit `.env` in step 8 (API keys) and `jobblast.config.json` in step
9. For now, the default values are enough to get started.

---

## 4. Start the database

From the project root:

```bash
docker compose up -d
```

This starts a Postgres 16 container named `jobblast-pg`, with the
credentials already expected by `.env.example`
(`postgres://postgres:postgres@localhost:5432/jobblast`). Check that it's
running:

```bash
docker ps
```

You should see a `jobblast-pg` line with status `Up`.

---

## 5. Create the tables

```bash
pnpm --filter @workspace/db run push
```

This command (Drizzle) creates the schema (`profiles`, `job_listings`,
`applications`, `documents` tables) in the database you just started, from
`lib/db/src/schema/`. It's safe to run again later if the schema changes
(it adjusts, it doesn't delete your data).

---

## 6. Run the app in development mode

Two processes to start, in two separate terminals (both read the same
`.env` at the project root):

```bash
# Terminal 1 - the API (port 5000 by default)
pnpm run dev:api
```

```bash
# Terminal 2 - the frontend (port 5173 by default, proxied to the API)
pnpm run dev:web
```

Then open **http://localhost:5173** in your browser. You should see the
JobBlast dashboard (probably empty on first launch, while the first job
aggregation cycle finishes in the background - anywhere from a few dozen
seconds to a few minutes depending on how many sources are enabled).

`pnpm run dev:api` builds then starts (no hot reload): re-run the command
after changing server code. The frontend (Vite) reloads automatically.

---

## 7. Fill in your profile

Go to the **Profile** page (left-hand menu):

- **Identity**: name, headline (the tagline that describes you, e.g.
  "Embedded Software Engineer"), salary floor.
- **Targeting**: target roles (tags, e.g. "Software Engineer", "Firmware
  Engineer"), target locations (tags, e.g. "Paris", "Remote"), excluded
  companies.
- **Master resume**: paste your entire resume/background in plain text -
  this is the raw material the AI uses to generate resume bullets tailored
  to each posting. The richer and more concrete it is (what you did, with
  which technologies, what impact), the better the generated applications
  will be.
- **My documents** (at the bottom of the Profile page): upload your **CV
  as a PDF** - its text is automatically extracted and enriches/replaces
  the "Master resume" above - and your **cover letter as a PDF**
  (optional, mainly used as a fallback if `config/cover-letter-template.txt`
  is empty). Both files are stored locally in `data/documents/` (not
  tracked by git).

Click **Save profile** to save.

---

## 8. Get free API keys

Two sources need a (free) key; the other nine need none and already work
with no setup.

### France Travail

1. Go to [francetravail.io](https://francetravail.io/) and create an
   account (or log in).
2. In your developer space, create an **application** (give it a name,
   e.g. "jobblast").
3. Among the APIs available for that application, look for **"Offres
   d'emploi v2"** and subscribe to it (free access, no credit card).
4. Once subscribed, the application's settings show a **Client ID** and a
   **Client Secret**. Copy them.
5. Paste them into `.env`:

   ```
   FRANCETRAVAIL_CLIENT_ID=PAR_yourapp_...
   FRANCETRAVAIL_CLIENT_SECRET=...
   ```

(The francetravail.io interface changes from time to time - the principle
stays the same: create an application, subscribe to the "Offres d'emploi
v2" API, grab the two OAuth2 credentials.)

### Adzuna

1. Go to [developer.adzuna.com](https://developer.adzuna.com/) and sign up
   ("Register", email + password).
2. Once logged in, your dashboard directly shows an **Application ID** and
   an **Application Key** for an automatically created application
   (otherwise, create one via "Add another application").
3. Paste them into `.env`:

   ```
   ADZUNA_APP_ID=...
   ADZUNA_APP_KEY=...
   ```

Adzuna's free plan has a fairly low call quota - see the FAQ if you run
into 429 errors.

**Neither key is required.** Without them, the corresponding sources are
simply skipped (a log line, no error) and JobBlast keeps working with
Greenhouse, Lever, RemoteOK, Remotive, Himalayas, Arbeitnow, Yourator,
TokyoDev, and japan-dev.

---

## 9. Adapt `jobblast.config.json` to your profile

`jobblast.config.json` (created in step 3) ships with scoring rules tuned
for an "embedded / C++ / systems" profile - **it's an example, not a
neutral default**. Edit it so it matches your job search:

- **`contact`**: your name, email, phone, city (used on the cover letter
  PDF and in the outbound HTTP User-Agent).
- **`scoring.rules`**: the list of keywords (regexes) that raise a
  posting's score, each with a weight and an explanation shown in the UI.
  Replace the C++/embedded rules with your own skills.
- **`scoring.penalties`**: the defaults assume a junior profile based in
  Europe with no US work authorization - if that's not your case, adjust
  or disable `usLocation` / `workAuthorization` (weight to `0` or remove
  the key).
- **`sources`**: enable/disable each source (`enabled: true/false`), and
  for France Travail/Adzuna/Greenhouse/Lever, adapt the keywords,
  departments, or boards to your search.
- **`coverLetterTemplatePath`**: defaults to
  `config/cover-letter-template.txt` - the file you edit next.

Full reference for every key: **[`docs/CONFIG.md`](CONFIG.md)**.

Also edit **`config/cover-letter-template.txt`**: replace the sample text
with your own template cover letter (structure, tone, sign-off). The AI
never copies it verbatim - it uses it as a model of structure and tone to
write a different letter for each posting.

After changing `jobblast.config.json`, restart `pnpm run dev:api` (the
file is re-read when the server starts).

---

## 10. Choose an AI provider (for AI letters)

Optional. JobBlast can write a resume-bullets-and-cover-letter pair tailored
to each posting, and it lets you pick which engine does it. Without an AI
provider the app still works end to end: you get a clean cover letter built
from your template plus bullets derived from your profile, marked in the UI
as a template draft.

Pick one of the six options below and put it in `jobblast.config.json`. The
whole `ai` section is optional, and leaving it out means option 1.

| Option | Cover letters | AI Scout | Notion Inbox | Cost |
|---|---|---|---|---|
| **0.** `none` | template only | no | no | free |
| **1.** `claude-cli` *(default)* | yes | yes | yes | your Claude subscription |
| **2.** `codex-cli` | yes | yes | if you added a Notion MCP server | your ChatGPT / Codex plan |
| **3.** `gemini-cli` | yes | web search only | no | your Gemini plan or an API key |
| **4.** `anthropic-api` | yes | no | no | metered per token |
| **5.** `openai-compatible`, incl. **Ollama** | yes | no | no | metered, or **free with Ollama** |

"AI Scout" and "Notion Inbox" are the two optional job sources from step 13 ("Advanced options");
they need an agent that can call tools, which only options 1 to 3 provide.

Every key of every option is documented in
[`docs/CONFIG.md`](CONFIG.md#ai).

---

### Option 0: no AI at all

```json
"ai": { "provider": "none" }
```

Nothing to install. No CLI is ever launched and no API is ever called. Every
posting keeps the template cover letter and the bullets derived from your
profile. Aggregation, scoring, the review queue, PDF export and the
application tracker all work normally. This is also a good way to get the
app running first and decide on a provider later.

### Option 1: Claude Code CLI (default, recommended)

This is what JobBlast uses when you write no `ai` section at all. It is the
only option where the two optional sources work fully, because your claude.ai
connectors (Notion, Indeed, Snagajob, ...) are reachable from a headless
session.

1. Install the CLI with the native installer (recommended):

   ```powershell
   # Windows (PowerShell)
   irm https://claude.ai/install.ps1 | iex
   ```

   ```bash
   # macOS / Linux
   curl -fsSL https://claude.ai/install.sh | bash
   ```

   (Also available via Homebrew or WinGet. The older
   `npm install -g @anthropic-ai/claude-code` method also works if you
   prefer it.)

2. Connect it to your account (Claude Pro/Max subscription, or a Console
   API key depending on your setup):

   ```bash
   claude
   ```

   The first run automatically opens a login flow in your browser. Follow
   the prompts, then exit (`/exit` or `Ctrl+C`). To log in again or switch
   accounts later, use `/login` in a session.

3. Verify it works:

   ```bash
   claude -p "say hello" --output-format json
   ```

   You should get JSON back with `"is_error": false` and a non-empty
   `"result"`.

4. Nothing to configure. If you want to be explicit, or to change the model:

   ```json
   "ai": { "provider": "claude-cli", "model": "sonnet" }
   ```

### Option 2: OpenAI Codex CLI

```json
"ai": { "provider": "codex-cli", "codexCli": { "model": "" } }
```

Install it (`npm install -g @openai/codex`, or Homebrew), then `codex login`
once. Leave `model` empty to use whatever Codex is already configured with.

JobBlast calls `codex exec` non-interactively with a read-only sandbox and
reads back the final message. AI Scout works (web search is enabled per run);
the Notion Inbox works too, but only if you added a Notion MCP server to your
own `~/.codex/config.toml` - Codex has no per-run connector list.

### Option 3: Google Gemini CLI

```json
"ai": { "provider": "gemini-cli", "geminiCli": { "model": "" } }
```

Install it (`npm install -g @google/gemini-cli`), then run `gemini` once to
authenticate, or set `GEMINI_API_KEY` in `.env`.

Cover letters work. AI Scout works for the web-search half only, and the
Notion Inbox does not work: Gemini's MCP servers are named in your own
`~/.gemini/settings.json`, which JobBlast cannot read. Note that agent runs
have to pass `--approval-mode yolo`, which auto-approves every tool the agent
decides to call - prefer option 1 or 2 if you plan to enable AI Scout.

### Option 4: Anthropic API (metered)

```json
"ai": { "provider": "anthropic-api", "anthropicApi": { "model": "claude-opus-5", "maxTokens": 4096 } }
```

Create a key at [console.anthropic.com](https://console.anthropic.com/) and
put it in `.env` as `ANTHROPIC_API_KEY` - never in `jobblast.config.json`,
which you might want to share. Cover letters only, billed per token.

### Option 5: any OpenAI-compatible endpoint, including free local models

One HTTP call in the OpenAI Chat Completions shape, which covers OpenAI,
OpenRouter, Mistral, Groq, vLLM, LM Studio and Ollama.

**Free and 100 % local, with Ollama.** Nothing leaves your machine, and
there is no bill:

```bash
# 1. Install Ollama
winget install Ollama.Ollama              # Windows
brew install ollama                        # macOS
curl -fsSL https://ollama.com/install.sh | sh   # Linux

# 2. Pull a model (about 4.7 GB; llama3.2:3b or qwen2.5:3b are smaller)
ollama pull llama3.1
```

```json
"ai": { "provider": "ollama" }
```

That is the entire configuration: the endpoint
(`http://localhost:11434/v1`), the model (`llama3.1`) and "no API key" are
all preset for you. `"provider": "lmstudio"` does the same for LM Studio on
`http://localhost:1234/v1`.

Two things to expect from a small local model: the letters are rougher and
follow the structure and language rules less reliably, and when a response
comes back malformed JobBlast rejects it rather than showing it to you, so
that posting simply keeps its template letter. It is retried on the next
pass, up to 3 times per server run.

For a hosted endpoint instead:

```json
"ai": {
  "provider": "openai-compatible",
  "openaiCompatible": {
    "baseUrl": "https://api.openai.com/v1",
    "apiKeyEnv": "OPENAI_API_KEY",
    "model": "gpt-4o-mini"
  }
}
```

and put `OPENAI_API_KEY` in `.env`.

---

Whichever you pick, restart the API after editing `jobblast.config.json` -
the file is read at startup. The first log line after "Server listening"
tells you which provider is active and whether it can run agents.

One deployment note for options 1 to 3: the CLI runs under the operating
system account that runs the server process, so if you deploy it as a
scheduled task or service (step 11), it is **that account** that must be
logged in (the CLI must have been authenticated at least once under that
user).

If the provider you chose turns out to be unusable - CLI not installed, key
not set, local server not running - JobBlast logs one warning, falls back to
template letters for the rest of that run, and does not keep retrying. Fix
the cause and restart.

---

## 11. Deploy in "local production"

Once your profile and config are ready, you can run JobBlast permanently
on your machine (a single Node process serves both the API and the
already-built frontend), without needing an open terminal.

### Windows

```powershell
pwsh -NoProfile -ExecutionPolicy Bypass -File .\deploy\build.ps1
pwsh -NoProfile -ExecutionPolicy Bypass -File .\deploy\register-task.ps1
```

`register-task.ps1` creates a Windows **Scheduled Task** named `JobBlast`
that starts the app at logon. Full details, log commands, and how to
restart after a code change: see
**[`deploy/README.md`](../deploy/README.md)**.

### Linux / macOS

```bash
chmod +x deploy/*.sh   # once, if the executable bit doesn't survive the clone
bash deploy/build.sh
bash deploy/start-jobblast.sh
```

For auto-start at boot: see the systemd (Linux) / launchd (macOS) section
of **[`deploy/README.md`](../deploy/README.md)**.

Either way, the app then runs at **http://localhost:5000/**.

---

## 12. Daily usage routine

Once deployed, the routine becomes very simple:

1. **Morning**: open `http://localhost:5000/review` (or `:5173` in dev).
   The server has already aggregated new postings (every 6h) and
   generated AI letters for the most recent ones (every 30 min).
2. For each posting in the **Review queue**: read "Why this surfaced"
   (⚠ = a point of caution, e.g. "5 years of experience required"),
   review/edit the generated letter, then:
   - **Approve & log application** -> opens the posting on the employer's
     site in a new tab, and creates a "TO SEND" entry in the tracker.
     Nothing is ever submitted automatically.
   - **Skip** -> moves on to the next one.
3. Actually apply on the employer's own site (the CV and cover letter PDFs
   are directly accessible from the posting card: "My CV" / "Cover letter
   PDF" buttons).
4. Go back to **Applications**, find the matching row, click **"I
   applied"** to confirm - the application then moves from "TO SEND" to
   "Applied" in the tracker.
5. When a recruiter replies, edit the row (pencil icon) to update the
   status (`Responded` / `Interview` / `Offer` / `Rejected`) and, if
   needed, a follow-up date.

Everything else (aggregation, scoring, AI generation) is automatic as long
as the server is running.

---

## 13. Advanced options

### AI Scout (claude.ai connectors + web search)

A headless Claude agent that queries your claude.ai job-search connectors
(Indeed, Snagajob, Aquent, JobDataLake...) and the web to find postings
the structured APIs don't cover. Disabled by default, limited to one run
per 24h.

1. Connect your connectors at
   **claude.ai/customize/connectors** (each connector is configured and
   authorized there, independently of JobBlast). Once authorized on your
   account, they automatically become available to your headless CLI
   sessions (`claude -p`) as long as the CLI is logged into that same
   account.
2. To find the exact name to use in `allowedConnectors` below, list the
   MCP servers visible to the CLI:

   ```bash
   claude mcp list
   ```

   (This command mostly lists locally added MCP servers; claude.ai account
   connectors like Notion/Indeed/Gmail are available even if they don't
   show up there explicitly. If unsure of the exact name, keep the format
   `mcp__claude_ai_<ConnectorName>` used in `jobblast.config.example.json`.)

3. In `jobblast.config.json`, under `sources.aiScout`:

   ```json
   "aiScout": {
     "enabled": true,
     "allowedConnectors": ["mcp__claude_ai_Indeed", "mcp__claude_ai_Snagajob"],
     "targetCompanies": [],
     "targetSites": [],
     "maxPostings": 15,
     "effortLevel": "high"
   }
   ```

   (Connector names follow the name listed by `claude mcp list`, with
   spaces/dots replaced by `_` and prefixed with `mcp__`.)

Full reference: `docs/CONFIG.md` -> `sources.aiScout`.

### Notion Inbox + cloud routine

A bridge that imports postings dropped into a Notion database into
JobBlast - typically fed by a scheduled Claude routine that runs in the
cloud, **even while your machine is off**.

**Step 1 - create the Notion database**, with these properties (the names
are customizable in the config, these are just an example): `Title`
(title), `Company` (text), `URL` (url), `Location` (text), `Why` (text),
`Source` (text), `Imported` (checkbox - **reserved for the app**, never
tick it manually).

**Step 2 - configure `jobblast.config.json`**:

```json
"notionInbox": {
  "enabled": true,
  "pageUrl": "<NOTION PAGE URL>",
  "dataSourceUrl": "<NOTION DATA SOURCE URL>",
  "properties": {
    "title": "Title", "company": "Company", "url": "URL",
    "location": "Location", "why": "Why", "source": "Source",
    "imported": "Imported"
  }
}
```

**Step 3 - create the scheduled routine** that feeds this database. This
feature is called **Routines** and runs on Anthropic's cloud
infrastructure (so it works even with your machine off) - two ways to set
one up:

- Web interface: [claude.ai/code/routines](https://claude.ai/code/routines)
  -> "New routine" -> prompt, connectors to authorize, schedule
  (daily/hourly/custom cron).
- From a CLI session: `/schedule "description of the task"` (Claude Code
  then walks you through it step by step).

Schedule it, for example, every day at 6:30 AM, with a prompt along these
lines:

```
You are a job scout. Find REAL, CURRENTLY OPEN postings matching this
profile:

Profile: <YOUR PROFILE SUMMARY, e.g. "Junior embedded software engineer">
Target roles: <TARGET ROLES>
Target locations: <TARGET LOCATIONS, or "full remote">
Constraints: no US nationality/visa restriction, junior/entry level
accepted.

1. Use your job-search connectors first (Indeed, Snagajob, Aquent,
   JobDataLake...), then web search to fill in the gaps.
2. For each posting you keep (10 max), verify the URL points to ONE
   specific listing (never a search results page).
3. Add each posting as a new row in the Notion database
   "<NOTION DATABASE NAME>" (<NOTION PAGE URL>):
   - Title = job title
   - Company = company name
   - URL = direct link to the listing
   - Location = location
   - Why = 1-2 sentences on why it fits the profile
   - Source = where it came from (connector or website)
   Never create a duplicate (check by URL before adding a row), and never
   touch the "Imported" checkbox (reserved for another automation).
```

The JobBlast server's `sources.notionInbox` bridge then reads this
database (at most once every 3h) and imports rows not yet "Imported" into
the usual pipeline (scoring, tailoring, review).

Full reference: `docs/CONFIG.md` -> `sources.notionInbox`.

### Gmail morning digest (read-only)

An optional scheduled routine, independent of JobBlast, that scans your
Gmail inbox every morning to spot recruiter replies and save you from
digging through it manually. Generic example prompt (to schedule via
claude.ai, with the Gmail connector authorized beforehand, **read-only** -
don't send or archive anything):

```
Scan my Gmail inbox (read-only, don't modify or send anything) for the
last 24 hours. Look for emails related to my job search (applications
sent to <LIST OF COMPANIES OR KEYWORDS, if useful>).
Classify each email you find as:
  [confirmation] application received
  [interview] interview proposal
  [offer] positive reply / offer
  [rejection] rejection
Sort with interviews first. For each email, give the company, the role
(if identifiable), and a one-line summary.
End with a reminder: "Remember to update the corresponding statuses in
your application tracker (http://localhost:5000/applications)."
```

### Local briefing (health check + refresh + summary)

A **local** scheduled task (on your own machine, via Windows Task
Scheduler / cron / launchd, not in the cloud, since it needs the JobBlast
server already running) that checks everything is healthy and gives you a
summary of the day. Example prompt, run by a local scheduled Claude Code
CLI in the morning:

```
Make these calls in order against the local JobBlast server
(http://localhost:5000, adjust the port if needed):

1. GET /api/healthz - if it fails, say so and stop there (the server is
   probably not running: see deploy/start-jobblast.*).
2. POST /api/jobs/refresh - triggers a job refresh.
3. GET /api/jobs?status=queued - lists postings waiting for review.
4. GET /api/applications?status=approved - "TO SEND" applications not yet
   confirmed as sent.
5. GET /api/dashboard - overall stats.

Summarize: the top 5 postings in the queue (title, company, score), the
number of "TO SEND" applications waiting for confirmation, the dashboard
stats, and highlight "today's pick" (the highest score).
```

In practice this can be a simple shell/PowerShell script with `curl`
piped into `claude -p` for formatting, or an equivalent local scheduled
Claude Code task - the important part is just that it runs **after**
`deploy/start-jobblast.*` has started the server.

---

## 14. Privacy

Everything runs on your own machine, against your own Postgres database.
There's no telemetry and no account system built into JobBlast itself.

**Where your personal data lives.** Nothing user-specific is committed to
the source tree. These files/folders hold your data and are gitignored
(see `.gitignore`):

| Path | Content |
|---|---|
| `.env` | Secrets and ports: `DATABASE_URL`, job-source API credentials, `PORT` |
| `jobblast.config.json` | Your name/email/phone/city, scoring rules, which sources are enabled, Notion IDs if you use the Notion Inbox |
| `config/cover-letter-template.txt` | Your template cover letter |
| `data/` | Uploaded CV/cover-letter PDFs, plus a couple of throttle-state timestamp files |
| `deploy/logs/` | Server logs (may contain postings, application data, and stack traces) |

Your profile itself (name, headline, target roles/locations, master
resume) lives only in your local Postgres database - it's never written
into a file that could be committed.

**What leaves the machine.** Three kinds of outbound traffic, all
explicit and all things you configured:
- HTTP calls to the job sources you enabled in `jobblast.config.json`
  (France Travail, Adzuna, Greenhouse, Lever, RemoteOK, Remotive,
  Himalayas, Arbeitnow, Yourator, TokyoDev, japan-dev) - read-only search
  requests, with your own API credentials where a key is required.
- Calls to whichever AI provider you chose in step 10, for AI tailoring
  (resume bullets, cover letters) and, if enabled, AI Scout. With the
  default `claude-cli` that is Anthropic, billed against your existing
  Claude subscription rather than a separate metered API key. With
  `ollama` or `lmstudio` nothing leaves the machine at all, and with
  `none` there is no such traffic in the first place.
- If you set up the optional cloud routines (AI Scout's connectors,
  Notion Inbox, Gmail digest, or any claude.ai Routine) - those run on
  Anthropic's infrastructure under your claude.ai account, independently
  of your machine, and only touch the services you explicitly authorized
  (Notion, Gmail, job connectors...).

Nothing is ever submitted to an employer automatically - approving a
match only opens the posting for you to apply on yourself.

**Wiping your data.** To start over or remove everything personal:
1. Stop the server (`deploy\stop-jobblast.ps1` / `deploy/stop-jobblast.sh`,
   or just close the `pnpm run dev:api` terminal).
2. Drop the database content: `docker compose down -v` removes the
   `jobblast-pg` container together with its volume (all profile, job,
   and application data). If you use your own Postgres instance, drop the
   `jobblast` database manually instead.
3. Delete the local files that hold personal data: `data/` (uploaded
   PDFs), `deploy/logs/` (logs), and, if you want a completely clean
   slate, `.env`, `jobblast.config.json`, and
   `config/cover-letter-template.txt` themselves (re-run `pnpm run setup`
   afterwards to regenerate empty copies from the examples).
4. Optionally, run `claude /logout` if you also want to disconnect the
   Claude Code CLI from your Anthropic account on this machine.

---

## 15. FAQ / troubleshooting

**"Port 5000 already in use"**
Another process is already listening on it (maybe an existing JobBlast
instance). Change `PORT` in `.env`, or find and stop the old process:
- Windows: `Get-NetTCPConnection -LocalPort 5000 -State Listen` then
  `Stop-Process -Id <PID>`, or simply `deploy\stop-jobblast.ps1`.
- Linux/macOS: `lsof -i :5000` then `kill <PID>`, or
  `deploy/stop-jobblast.sh`.

**Docker Desktop isn't running**
`docker compose up -d` (or `docker ps`) fails with a Docker daemon
connection error. Launch Docker Desktop and retry once its tray icon is
stable. For unattended deployment (scheduled task / service), remember to
enable "Start Docker Desktop when you log in" in Docker Desktop's
settings.

**`claude` isn't logged in / errors in the logs about tailoring**
Job aggregation keeps working, but letters stay on the generic template.
Run `claude` (or `claude -p "test" --output-format json`) under the same
system user account that runs the JobBlast server, and follow the login
flow. If JobBlast runs as a scheduled task/service under a particular
user, it's that user who needs `claude` logged in.

**pnpm fails to install a binary on Windows (e.g. native build errors)**
Make sure you're using a standard CLI (PowerShell or Git Bash), with Node
24+ and pnpm 10 correctly installed (`node -v`, `pnpm -v`). Some native
packages need the Visual Studio "Build Tools" if a precompiled binary
isn't available for your Node version - rare with this project, but if
`pnpm install` fails on a specific package, look up the exact error
(often `node-gyp`) and install what it asks for.

**Adzuna returns 429 errors / rate limit**
Adzuna's free plan has a fairly low daily call quota. Reduce
`sources.adzuna.queries` (fewer keywords) in `jobblast.config.json`, or
temporarily disable the source (`"enabled": false`) - the other 10
sources keep working normally.

**The 104 source (104.com.tw) returns nothing**
That's expected and intentional: `sources.job104` is disabled by default
because its search endpoint sits behind Cloudflare bot protection that
blocks automated requests. Enabling it just wastes request budget for zero
results - see the note in `jobblast.config.example.json` / `docs/CONFIG.md`.

**Nothing shows up in the review queue after the first launch**
The first aggregation cycle starts in the background when the server
starts and can take anywhere from a few dozen seconds to a few minutes
(depending on how many sources are enabled). Check the server logs
(the `pnpm run dev:api` terminal, or `deploy/logs/jobblast.log` in
production) to see the progress (`"Job refresh: fetching enabled
sources"` then `"Job refresh complete"`). If the number of inserted
postings stays at 0, check that your scoring rules
(`jobblast.config.json` -> `scoring.rules` / `scoring.minRelevanceScore`)
aren't too strict for the postings your enabled sources actually return.

### I already run Postgres (or another JobBlast) in Docker. `docker compose up -d` fails or reuses the wrong container

`docker-compose.yml` names the container `jobblast-pg` and publishes port 5432. For a second instance, edit the compose file (for example `container_name: jobblast-pg-2`, `"5433:5432"`), then in `.env` set `DATABASE_URL` to port 5433, `PG_CONTAINER_NAME=jobblast-pg-2`, and pick free ports with `PORT=5010`, `FRONTEND_PORT=5174`, `API_PROXY_TARGET=http://localhost:5010`. Both the API and the Vite dev server read the root `.env`.

### Windows: `deploy\*.ps1` fails with a syntax error

The deploy scripts need PowerShell 7 (`pwsh`), not the Windows PowerShell 5.1 that ships with Windows. Install it with `winget install Microsoft.PowerShell`, then run the scripts from a `pwsh` terminal.
