# Configuring JobBlast

JobBlast keeps everything user-specific out of the source tree. There are
three places your own data can live, and only these three:

| Where | What | Committed? |
|---|---|---|
| **Postgres `profiles` row** | Your name, e-mail, headline, target roles, target locations, salary floor, master resume | no (database) |
| **`.env`** | Secrets and ports: `DATABASE_URL`, API credentials, `PORT`… | no - see `.env.example` |
| **`jobblast.config.json`** | Everything else: letterhead details, language rules, scoring rules, which AI provider writes your letters, which job sources to poll and with what parameters | no - see `jobblast.config.example.json` |

Plus one optional text file, `config/cover-letter-template.txt`, holding the
cover letter the AI tailoring pass imitates.

Nothing in `artifacts/`, `lib/`, `deploy/` or `scripts/` contains personal
data. If you find some, it's a bug.

---

## The Settings page

Most of the `ai` section below and the automation toggles under
[`sources.aiScout`](#sourcesaiscout), [`sources.notionInbox`](#sourcesnotioninbox)
and [`gmailSync`](#gmailsync) can also be set from the app itself, at
**Settings** (gear icon in the sidebar) instead of hand-editing this file.
The page shows which AI providers it can actually detect on this machine
right now (CLI on PATH, local server reachable, API key present in `.env`)
and lets you switch between them, edit the model, run a real one-line test
call, and flip the automation toggles - including the two Notion Inbox URLs.

It writes back to `jobblast.config.json` with a surgical, formatting-
preserving edit (only the keys you changed move; everything else, including
`scoring.rules` and any `_comment` keys, is left byte-for-byte alone) and
re-validates the file the same way `loadConfig()` does at startup, so an
update from the wizard can never leave the file in an invalid state.
**`jobblast.config.json` stays the source of truth** - the wizard is a
convenience layer on top of it, not a replacement; every key it can change is
still safe (and sometimes necessary, e.g. `scoring` or `sources.aiScout.
allowedConnectors`) to edit by hand. Secrets never appear in the wizard: API
keys stay in `.env`, and the page only ever reports whether the variable a
provider needs is set, never its value.

---

## Getting started

```bash
cp jobblast.config.example.json jobblast.config.json
cp config/cover-letter-template.example.txt config/cover-letter-template.txt
cp .env.example .env
```

Then edit the three copies. All three are gitignored.

**The config file is entirely optional.** Every key has a built-in default,
so the app boots and runs without `jobblast.config.json` at all - it just
scores jobs against a generic embedded/C++/systems profile and skips the
sources that need explicit setup. What is *not* optional is validity: a file
that exists but is malformed (bad JSON, wrong type, invalid regex) aborts
startup with an explicit error rather than being silently ignored.

Set `JOBBLAST_CONFIG` in `.env` to load the config from a different path
(absolute, or relative to the repo root).

### Writing regexes in JSON

Patterns are written as `{ "pattern": "...", "flags": "i" }` pairs and
compiled once at startup. Remember that JSON needs backslashes doubled:
the regex `\bc\+\+\b` is written `"\\bc\\+\\+\\b"`.

### Comments

JSON has no comments. Any key starting with `_` (e.g. `"_comment"`) is
ignored by the loader, so you can annotate your config freely - the example
file does exactly that.

---

## `contact`

Your letterhead and how the app identifies itself to job boards.

| Key | Default | Used by |
|---|---|---|
| `name` | `"Your Name"` | Cover letter PDF header; the name the AI signs letters with |
| `email` | `""` | Cover letter PDF; contact address in the outbound HTTP `User-Agent` |
| `phone` | `""` | Cover letter PDF |
| `city` | `""` | Cover letter PDF (header line and the date line, e.g. "Paris, le 3 mars 2026") |

Empty fields are simply omitted from the PDF and the `User-Agent`. If `name`
is empty, the AI is told to sign with the name it finds in your master
resume instead.

## `candidate`

The language rule for generated applications.

| Key | Default | Meaning |
|---|---|---|
| `nativeLanguage` | `"en"` | ISO 639-1 code. Selects the date locale on the cover letter PDF (`fr` also switches it to the French "City, le <date>" form) |
| `letterLanguages` | `["en"]` | Languages you can credibly write an application in |
| `fallbackLetterLanguage` | `"en"` | Language used when the posting is in none of the above |

The rule handed to the model: *if the posting is written in one of
`letterLanguages`, write the letter and bullets in that language; otherwise
write them in `fallbackLetterLanguage`* (optionally opening with one greeting
sentence in the posting's language). It is never told to write in a language
you didn't list.

## `coverLetterTemplatePath`

Default `"config/cover-letter-template.txt"` (absolute, or relative to the
repo root). The plain-text cover letter the AI imitates for structure, tone
and sign-off - it is never copied verbatim.

Resolution order, first hit wins:

1. the file at this path,
2. the text extracted from the `cover_letter` PDF you uploaded on the
   Documents page,
3. a neutral built-in placeholder.

So you can skip the file entirely and just upload your letter as a PDF.

## `ai`

Which engine writes your cover letters, and whether the agent-backed features
(AI Scout, Notion Inbox, [Gmail sync](#gmailsync)) can run at all. **The whole
section is optional**: a config file with no `ai` key behaves exactly as
JobBlast did before providers existed, i.e. the local `claude` CLI.

| Key | Default | Meaning |
|---|---|---|
| `provider` | `"claude-cli"` | One of `none`, `claude-cli`, `codex-cli`, `gemini-cli`, `anthropic-api`, `openai-compatible`, `ollama`, `lmstudio`. Anything else aborts startup |
| `model` | `"sonnet"` | Model for `claude-cli` (passed as `claude --model`). The other providers have their own model key |
| `timeoutMs` | `180000` | Default per-call timeout. AI Scout (10 min), Notion Inbox (4 min), Gmail sync (4 min) and interview briefs (12 min) use their own |
| `fitAnalysis.enabled` | `true` | Whether the fit-analysis pass (red/green flags, `lib/ai/fit-analysis.ts`) runs. Set `false` to skip it while keeping cover-letter tailoring on |
| `openaiCompatible` | see below | Only for `openai-compatible` / `ollama` / `lmstudio` |
| `anthropicApi.model` | `"claude-opus-5"` | Only for `anthropic-api` |
| `anthropicApi.maxTokens` | `4096` | Only for `anthropic-api` |
| `codexCli.model` | `""` | Only for `codex-cli`. Empty means "let Codex use its own default" |
| `codexCli.extraArgs` | `[]` | Extra `codex exec` arguments, appended verbatim |
| `geminiCli.model` | `""` | Only for `gemini-cli`. Empty means "let Gemini use its own default" |
| `geminiCli.extraArgs` | `[]` | Extra `gemini` arguments, appended verbatim |

### What each provider can do

| `provider` | Cover letters | AI Scout | Notion Inbox | Gmail sync | Interview briefs | Cost | Needs |
|---|---|---|---|---|---|---|---|
| `none` | template only | no | no | no | no | free | nothing |
| `claude-cli` *(default)* | yes | yes | yes | yes | yes | your Claude subscription, $0 per letter | `claude` CLI, logged in |
| `codex-cli` | yes | yes | yes, if you configured a Notion MCP server | **no, by design** | yes | your ChatGPT / Codex plan | `codex` CLI, logged in |
| `gemini-cli` | yes | web search only, no job connectors | no | no | yes | your Gemini plan or `GEMINI_API_KEY` | `gemini` CLI, authenticated |
| `anthropic-api` | yes | no | no | no | no | metered per token | `ANTHROPIC_API_KEY` in `.env` |
| `openai-compatible` | yes | no | no | no | no | metered per token | an API key, usually `OPENAI_API_KEY` |
| `ollama` / `lmstudio` | yes | no | no | no | no | **free, fully local** | Ollama or LM Studio running, one model pulled |

These features need an agent that can call tools (web search, MCP
connectors). On a provider that cannot, the feature logs one line and does
nothing - it does not error every cycle.

Gmail sync is stricter than the others and refuses providers that could
otherwise run it. It only works on `claude-cli`, because `--allowedTools` is
a real per-run allowlist: the agent is handed `search_threads`, `get_thread`,
`get_message` and `list_labels`, and the CLI itself refuses everything else,
so "read-only" is enforced rather than merely requested. `codex-cli` has no
per-run tool allowlist and `gemini-cli` runs agents under
`--approval-mode yolo`, so on both of those the only thing standing between
your mailbox and a sent reply would be the wording of a prompt. Gmail sync
declines to run there.

### `provider: "none"` - the zero-dependency option

No CLI is spawned and no API is called, ever. Each posting keeps the template
cover letter and the profile-derived bullets that the pipeline already wrote,
which the UI marks as a template draft. Everything else - aggregation,
scoring, the review queue, PDF export, the application tracker - works
normally. Pick this if you do not want any AI in the loop, or to get the app
running before you decide on a provider.

The same fallback happens automatically if the provider you chose turns out
to be unusable on this machine: a missing CLI binary, an unset API key, or a
local server that is not listening. JobBlast logs one warning, switches to
template letters for the rest of that process, and does not retry every 30
minutes. Fix the cause and restart the server to re-enable AI.

### `provider: "claude-cli"` (default)

The local Claude Code CLI run headless (`claude -p`). The only provider where
all three agent capabilities work out of the box, because the claude.ai
account-level MCP connectors (Notion, Indeed, Snagajob, Aquent, ...) are
reachable from a headless session and can be restricted per run with
`--allowedTools`. `ai.model` is passed as `claude --model` (`sonnet`, `opus`,
`haiku`, or a full model id).

### `provider: "codex-cli"`

The OpenAI Codex CLI in non-interactive mode. JobBlast runs:

```
codex exec - --sandbox read-only --skip-git-repo-check --color never -o <tmpfile> [-m <model>]
```

with the prompt on stdin (`-` reads stdin, which avoids Windows argv length
and quoting limits) and the final answer read back from the `-o` file. For an
agent run it adds `-c tools.web_search=true` for live web search and
`-c model_reasoning_effort="<level>"` for `sources.aiScout.effortLevel`.

MCP connectors are per-user, in `~/.codex/config.toml` under
`[mcp_servers.<name>]`. Codex has no per-run tool allowlist flag, so whatever
you configured there is what the agent can reach - which is why Notion Inbox
is listed as "if you configured a Notion MCP server" above.

Flags verified against a local `codex --help` / `codex exec --help` on
**codex-cli 0.145.0 (2026-08-22)**. Note that `--search` and `--effort` exist
on the top-level `codex` command but **not** on `codex exec` in that version,
which is why the `-c` overrides are used instead.

### `provider: "gemini-cli"`

The Google Gemini CLI headless:

```
gemini --output-format json --approval-mode <default|yolo> [-m <model>] -p "<prompt>"
```

The response is read from the `response` field of the JSON object it prints.
Prompts longer than 20 000 characters go on stdin instead of `-p` (Windows
caps a command line at about 32 767 characters); `-p` then carries a short
"follow the instructions above" line, because `-p` is what puts the CLI in
headless mode.

Agent support is **web search only**. Gemini's `google_web_search` is built
in, but its MCP servers live in your own `~/.gemini/settings.json` under
names JobBlast cannot guess, so Notion Inbox stays off. Note also that in
headless mode Gemini treats a tool call that would normally prompt as
*denied*, so agent runs pass `--approval-mode yolo`, which auto-approves
every tool the agent calls - and the prompt contains job descriptions fetched
from the open web. If you want AI Scout with a real per-run tool allowlist,
use `claude-cli`. Gemini's own `--allowed-tools` flag is marked deprecated in
0.56.0 and is therefore not used automatically; add it through
`ai.geminiCli.extraArgs` if you want it.

Flags verified against a local `gemini --help` on **gemini-cli 0.56.0
(2026-08-22)** and the repo's `docs/cli/headless.md`.

### `provider: "anthropic-api"`

The official Anthropic Messages API via `@anthropic-ai/sdk`. Text only: no
web search, no connectors, so AI Scout and Notion Inbox stay off.

The key is **not** a config key - put `ANTHROPIC_API_KEY` in `.env`, so your
config file stays safe to share. Configure `ai.anthropicApi.model` (default
`claude-opus-5`) and `ai.anthropicApi.maxTokens` (default `4096`; a cover
letter plus four bullets fits comfortably, raise it if you enlarge the
prompt).

### `provider: "openai-compatible"`, `"ollama"`, `"lmstudio"`

One `POST {baseUrl}/chat/completions` in the OpenAI Chat Completions shape.
That covers OpenAI, Ollama, LM Studio, OpenRouter, Mistral, Groq, vLLM and
anything else speaking the same protocol. Text only.

| Key | Meaning |
|---|---|
| `openaiCompatible.baseUrl` | Endpoint root, **without** a trailing `/chat/completions` |
| `openaiCompatible.apiKeyEnv` | Name of the `.env` variable holding the bearer token. Set it to `""` for a local server that needs no key |
| `openaiCompatible.model` | Model id to request |
| `openaiCompatible.temperature` | Optional. Omitted from the request when `null` |

Every key is optional. What you leave out comes from the preset for the
provider you named, so `"provider": "ollama"` on its own is already a
complete configuration:

| `provider` | `baseUrl` | `apiKeyEnv` | `model` |
|---|---|---|---|
| `openai-compatible` | `https://api.openai.com/v1` | `OPENAI_API_KEY` | `gpt-4o-mini` |
| `ollama` | `http://localhost:11434/v1` | `""` (none) | `llama3.1` |
| `lmstudio` | `http://localhost:1234/v1` | `""` (none) | `local-model` |

Anything you *do* set wins over the preset, key by key.

**Free, 100 % local AI with Ollama.** Install Ollama
(`winget install Ollama.Ollama` on Windows, `brew install ollama` on macOS,
`curl -fsSL https://ollama.com/install.sh | sh` on Linux), pull a model, and
point JobBlast at it:

```bash
ollama pull llama3.1        # about 4.7 GB; llama3.2:3b or qwen2.5:3b are smaller
```

```json
"ai": { "provider": "ollama" }
```

Nothing leaves your machine and there is no bill. Two caveats worth knowing
before you rely on it:

- **Small models write rougher letters.** They follow the structure and the
  language rules less reliably than a frontier model. The sanitizer and the
  strict-JSON validation still apply, so a bad response is rejected rather
  than shown to you - the posting simply keeps its template letter.
- **A rejected response is retried, but not forever.** A posting whose
  generation fails or returns invalid JSON is retried on the next pass, at
  most **3 times per server process**. After that it keeps the template
  letter until you restart. This stops one awkward posting from consuming
  every pass.

Other endpoints follow the same shape, for example OpenRouter:

```json
"ai": {
  "provider": "openai-compatible",
  "openaiCompatible": {
    "baseUrl": "https://openrouter.ai/api/v1",
    "apiKeyEnv": "OPENROUTER_API_KEY",
    "model": "meta-llama/llama-3.1-70b-instruct"
  }
}
```

## `scoring`

A weighted-keyword relevance scorer - not ML. Each rule looks for a pattern
in the title and/or description, adds points, and records a human-readable
reason shown in the "why this surfaced" panel. **A hit in the title is worth
double the rule's weight.** The final score is clamped to `[0, scoreCap]`.

| Key | Default | Meaning |
|---|---|---|
| `rules` | 23 rules for an embedded/C++/systems profile | See below |
| `locationBonus` | `10` | Points added when the posting's location matches a target keyword |
| `locationBonusReason` | `"Target location matched ({location})"` | `{location}` is replaced with the posting's location |
| `scoreCap` | `98` | Maximum relevance score |
| `targetLocationKeywords` | `[]` | Lowercase substrings matched against the location field. **Empty means: derive them from your profile's `targetLocations`** (split on `/` and `,`, lowercased) |
| `targetishLocationPattern` | `null` | Broader "close enough to be actionable" test used by the off-site penalty - e.g. a whole country, or French département codes. `null` means: fall back to `targetLocationKeywords` |
| `remoteSignalPattern` | remote/télétravail/anywhere… | Matched against location, title and description; a hit exempts the posting from the off-site penalty |
| `penalties` | see below | |
| `minRelevanceScore` | `30` | Listings below this are dropped instead of queued for review |

### `scoring.rules[]`

```json
{
  "pattern": "\\bcmake\\b",
  "flags": "i",
  "skill": "CMake",
  "weight": 6,
  "reason": "CMake mentioned",
  "titleReason": "CMake in the title"
}
```

- `skill` - the bucket shown as a "highlighted skill" on the job card. Several
  rules may share one bucket.
- `weight` - points for a description hit; doubled for a title hit.
- `reason` / `titleReason` - the sentence shown to you. `titleReason` is
  optional and defaults to `"<reason> (title)"`.

### `scoring.penalties`

Negative-weight rules for postings that are a poor fit or not actionable.
Each is `{ pattern, flags, weight, reason }`; `reason` may contain
`{location}`.

| Key | Applied to | Default weight |
|---|---|---|
| `workAuthorization` | title + description | `-40` |
| `seniorYears` | title + description | `-20` |
| `seniorTitle` | **title only** | `-18` |
| `usLocation` | location field, only when no target keyword matched | `-15` |
| `offsiteNonTarget` | *(no pattern)* applied when the posting is neither target-ish nor remote | `-25` |

The shipped defaults assume a junior candidate based in Europe with no US
work authorization. Review them - for a US-based user, `usLocation` and
`workAuthorization` are actively wrong.

## `sources`

Every source has an `enabled` flag; disabled sources are not even called.
Credentials (France Travail, Adzuna) come from `.env`, not from here - a
source whose credentials are missing logs a line and contributes zero jobs
rather than failing the refresh.

| Source | Keys | Notes |
|---|---|---|
| `franceTravail` | `enabled`, `keywords[]`, `departements[]` | Needs `FRANCETRAVAIL_CLIENT_ID` / `_SECRET`. Each keyword is a separate search request - keep the list short |
| `adzuna` | `enabled`, `country`, `queries[]`, `where`, `resultsPerPage` | Needs `ADZUNA_APP_ID` / `_KEY`. Trial-plan rate limits are tight |
| `greenhouse` | `enabled`, `boards[{slug,name}]` | Public API, no key. Verify a slug first: `curl -s -o /dev/null -w '%{http_code}' https://boards-api.greenhouse.io/v1/boards/<slug>/jobs` |
| `lever` | `enabled`, `boards[{slug,name}]` | Public API, no key. Verify: `curl -s -o /dev/null -w '%{http_code}' 'https://api.lever.co/v0/postings/<slug>?mode=json'` |
| `remoteok` | `enabled`, `tags[]` | Public API |
| `remotive` | `enabled`, `category`, `search`, `limit` | Exactly one request per refresh cycle by design - Remotive documents ~4 calls/day. Don't add queries |
| `himalayas` | `enabled`, `queries[]`, `limit` | Public API |
| `yourator` | `enabled`, `pages[]`, `relevanceFilter` | Taiwan startup board. The API has no keyword search, so pages are fetched unfiltered and pre-filtered client-side by `relevanceFilter` |
| `tokyodev` | `enabled` | HTML scrape of the listing page |
| `japandev` | `enabled` | HTML scrape of the listing page |
| `arbeitnow` | `enabled` | Public API, page 1 only |
| `job104` | `enabled`, `queries[]`, `areaCodes[]` | **Off by default**: 104.com.tw's search endpoint is behind Cloudflare bot protection and currently returns zero jobs. Area codes: `6001001000` Taipei, `6001002000` New Taipei, `6001016000` Kaohsiung |
| `aiScout` | see below | Off by default |
| `notionInbox` | see below | Off by default |

### `sources.aiScout`

A headless agent that queries your job connectors and the live web, then
hands verified postings to the same pipeline. Requires an agent-capable
provider: `claude-cli` (the default, and the only one that reaches the
claude.ai job connectors) or `codex-cli`. On `gemini-cli` only the web half
runs; on every other provider the source logs one line and contributes
nothing - see [`ai`](#ai). Throttled to one run per 24 h via a timestamp file
under `data/`; every URL it returns is checked for liveness before being
accepted.

| Key | Default | Meaning |
|---|---|---|
| `enabled` | `false` | |
| `allowedConnectors[]` | Snagajob, Aquent, JobDataLake, Indeed | MCP server names. List yours with `claude mcp list`; the name is normalized by replacing spaces/dots with `_` and prefixing `mcp__` |
| `targetCompanies[]` | `[]` | Optional shortlist of companies whose career pages the agent should also check |
| `targetSites[]` | `[]` | Optional shortlist of job boards / sites to prioritize |
| `maxPostings` | `15` | Cap on returned postings |
| `effortLevel` | `"high"` | `low` \| `medium` \| `high` - passed to `claude --effort`, or to `codex -c model_reasoning_effort`. Ignored by providers with no effort knob |

The candidate description in the prompt comes entirely from your DB profile
(headline, target roles, target locations, master resume). Nothing about the
applicant is hardcoded.

### `sources.notionInbox`

Bridges a Notion database of job postings - typically fed by a scheduled
claude.ai routine that runs while your machine is off - into the pipeline.
Requires a provider whose agent can reach Notion over MCP: `claude-cli` with
the claude.ai Notion connector authorized, or `codex-cli` with a Notion MCP
server in `~/.codex/config.toml`. On any other provider the source logs one
line and contributes nothing - see [`ai`](#ai). Throttled to one run per 3 h.

| Key | Default | Meaning |
|---|---|---|
| `enabled` | `false` | |
| `pageUrl` | `""` | e.g. `https://app.notion.com/p/<page-id>` |
| `dataSourceUrl` | `""` | e.g. `collection://<data-source-id>` |
| `properties` | English names | Your database's actual property names |

`properties` maps the seven properties the bridge reads and writes:

```json
"properties": {
  "title": "Title",
  "company": "Company",
  "url": "URL",
  "location": "Location",
  "why": "Why",
  "source": "Source",
  "imported": "Imported"
}
```

`imported` must be a checkbox and is reserved for the app: it is ticked after
each row is read, so the same posting isn't imported twice. Both `pageUrl`
and `dataSourceUrl` must be set or the source skips with a warning.

---

## `gmailSync`

Reads the last few days of recruiter mail and moves matching applications
forward on their own, so the tracker stays current without you editing a
dropdown after every reply.

This is the only part of JobBlast that writes to your application tracker by
itself. It is off by default, and worth understanding before switching on.

| Key | Default | Meaning |
|---|---|---|
| `enabled` | `false` | Opt-in. Nothing runs until this is `true` |
| `dryRun` | `false` | Decide everything, write nothing. Every decision still lands in the journal |
| `lookbackDays` | `2` | How far back the mailbox search looks (`newer_than:<n>d`). Max 30 |

**Prerequisites.** `ai.provider` must be `claude-cli` (see [the capability
table](#what-each-provider-can-do)), with the claude.ai Gmail connector
authorized. Check it with:

```bash
claude mcp list      # look for "claude.ai Gmail: ... - ✔ Connected"
```

If the connector is missing, authorize it in your claude.ai connector
settings. Without it the pass logs one line and does nothing.

**Turn it on carefully.** Set `enabled` to `true` *and* `dryRun` to `true`,
let one cycle run, then read `data/gmail-sync-journal.jsonl`. It records what
would have happened. Once the decisions look right, set `dryRun` back to
`false`.

### How it works

Three passes, and the separation is the point:

1. **Read** (AI). A read-only agent searches your mail and returns a JSON
   list of application-related messages: company, guessed role, kind
   (`confirmation` / `reply` / `interview` / `rejection`), date, sender, and
   a short excerpt. The model never sees your database and cannot act.
2. **Match** (no AI). Plain TypeScript compares the company name from the
   e-mail against your applications, after folding both to a canonical form:
   lowercased, accents removed, punctuation and `&` turned into spaces,
   trailing legal forms (`SAS`, `SARL`, `GmbH`, `Inc`, `Ltd`, ...) stripped.
   Names match on exact equality, or when one is a whole-word run inside the
   other and the shorter is at least 4 characters. `Thales Group` matches
   `THALES`; `Orange` does not match `Orangerie`.
3. **Apply**. The allowed move is made and a dated line is appended to the
   application's notes.

### What it will and will not do

| | |
|---|---|
| Rows it can touch | only `applied` and `responded` |
| Rows it never touches | `approved` (prepared but not actually sent by you), `interview`, `rejected`, `offer` |
| Moves it can make | `applied` -> `responded`, `applied`/`responded` -> `interview`, `applied`/`responded` -> `rejected` |
| Moves it can never make | anything backwards, and **anything to `offer`** - an offer is yours to enter |
| `notes` | appended to, never overwritten |
| A `confirmation` e-mail | adds a note only, no status change |

Ambiguity always loses. Two applications at the same company matching one
e-mail, a company name too short to compare safely, or a rejection at a
company where you have several applications on file and the e-mail does not
clearly name which role: all of these are recorded and skipped rather than
guessed at. The pass is built so that a wrong destructive move is difficult,
not so that it catches everything.

Rejections get one extra check, because they are the move you are least
likely to notice going wrong. If the e-mail names a role and that role is
clearly not the one JobBlast is tracking, it is skipped even when the
company matches exactly and there is only one application on file. Your
tracker is not the whole truth - you may well have applied to the same
employer through another channel - so a rejection for "Order Engineer" will
not close your "Embedded Software Engineer" application. A rejection naming
no role at all still counts when there is only one application it could
possibly mean.

### The journal

Every decision, acted on or skipped, is appended as one JSON line to
`data/gmail-sync-journal.jsonl` (gitignored along with the rest of `data/`).
Each line carries the timestamp, whether it was a dry run, the e-mail as the
agent read it, the decision, the reason, and - when something changed - the
application id with its old and new status.

```jsonc
{"ts":"2026-08-25T14:02:11.204Z","mode":"live","key":"qonto|interview|2026-08-25|alice <alice@qonto.eu>",
 "decision":"acted","reason":"applied",
 "email":{"company":"Qonto","jobTitleGuess":"Backend Engineer","kind":"interview","date":"2026-08-25","from":"Alice <alice@qonto.eu>","excerpt":"Are you free Thursday for a 45 minute call?"},
 "application":{"id":10,"company":"Qonto","title":"Backend Engineer","fromStatus":"applied","toStatus":"interview"},
 "noteAppended":"[gmail-sync 2026-08-25] Interview invitation from Alice <alice@qonto.eu> - Are you free Thursday for a 45 minute call?"}
```

It is also how the same message is only ever acted on once: the search window
is days wide while the pass runs every 3 hours, so most messages are seen a
dozen times, and every sighting after the first is skipped with reason
`already-processed`. Dry-run lines deliberately do not count, so a rehearsal
never blocks the real run that follows it.

Common skip reasons: `no-matching-application`, `no-eligible-application`
(the company matched, but the row is `approved` or already past this pass),
`ambiguous-multiple-applications`, `rejection-role-ambiguous`,
`rejection-role-mismatch`, `status-already-set`, `transition-not-allowed`.

Throttled to one run per 3 h via `data/gmail-sync-last-run.txt`, and it runs
after the tailoring and fit-analysis passes, never alongside them.
