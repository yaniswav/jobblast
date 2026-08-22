# Configuring JobBlast

JobBlast keeps everything user-specific out of the source tree. There are
three places your own data can live, and only these three:

| Where | What | Committed? |
|---|---|---|
| **Postgres `profiles` row** | Your name, e-mail, headline, target roles, target locations, salary floor, master resume | no (database) |
| **`.env`** | Secrets and ports: `DATABASE_URL`, API credentials, `PORT`… | no - see `.env.example` |
| **`jobblast.config.json`** | Everything else: letterhead details, language rules, scoring rules, which job sources to poll and with what parameters | no - see `jobblast.config.example.json` |

Plus one optional text file, `config/cover-letter-template.txt`, holding the
cover letter the AI tailoring pass imitates.

Nothing in `artifacts/`, `lib/`, `deploy/` or `scripts/` contains personal
data. If you find some, it's a bug.

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

A headless `claude` CLI agent that queries your claude.ai job connectors and
the live web, then hands verified postings to the same pipeline. Requires the
`claude` CLI installed and logged in. Throttled to one run per 24 h via a
timestamp file under `data/`; every URL it returns is checked for liveness
before being accepted.

| Key | Default | Meaning |
|---|---|---|
| `enabled` | `false` | |
| `allowedConnectors[]` | Snagajob, Aquent, JobDataLake, Indeed | MCP server names. List yours with `claude mcp list`; the name is normalized by replacing spaces/dots with `_` and prefixing `mcp__` |
| `targetCompanies[]` | `[]` | Optional shortlist of companies whose career pages the agent should also check |
| `targetSites[]` | `[]` | Optional shortlist of job boards / sites to prioritize |
| `maxPostings` | `15` | Cap on returned postings |
| `effortLevel` | `"high"` | `low` \| `medium` \| `high` - passed to `claude --effort` |

The candidate description in the prompt comes entirely from your DB profile
(headline, target roles, target locations, master resume). Nothing about the
applicant is hardcoded.

### `sources.notionInbox`

Bridges a Notion database of job postings - typically fed by a scheduled
claude.ai routine that runs while your machine is off - into the pipeline.
Requires the claude.ai Notion connector. Throttled to one run per 3 h.

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
