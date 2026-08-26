// Central, user-specific configuration for JobBlast.
//
// Everything in this file exists so the codebase itself stays generic: no
// name, e-mail, phone number, Notion ID, company shortlist or profile-tuned
// scoring rule is hardcoded anywhere in `src/`. All of it comes from one
// gitignored JSON file at the repo root (`jobblast.config.json`), with
// `jobblast.config.example.json` committed as a documented starting point
// and `docs/CONFIG.md` describing every key.
//
// The file is optional: `loadConfig()` falls back to the defaults declared
// below (via Zod `.default()`s), so a fresh clone boots and runs without any
// configuration at all. What is NOT optional is validity - a config file
// that exists but is malformed throws at startup rather than being silently
// ignored, so a typo can't quietly disable a whole source or scoring rule.
//
// Regexes are expressed as `{ "pattern": "...", "flags": "i" }` pairs in
// JSON and compiled once here at load time, so an invalid pattern fails
// loudly at boot instead of at the first refresh cycle.

import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { BoundedCache } from "./lru";
import { IS_SAAS } from "./mode";
import { REPO_ROOT } from "./storage";
import { currentUserId } from "./user-context";

// ---------------------------------------------------------------------------
// Building blocks
// ---------------------------------------------------------------------------

const RegexSpecSchema = z.object({
  pattern: z.string().min(1),
  flags: z.string().default("i"),
});
export type RegexSpec = z.infer<typeof RegexSpecSchema>;

const ScoringRuleSchema = z.object({
  pattern: z.string().min(1),
  flags: z.string().default("i"),
  /** Skill bucket surfaced in the UI ("highlighted skills"). */
  skill: z.string().min(1),
  weight: z.number(),
  /** Reason shown when the pattern matches in the description. */
  reason: z.string().min(1),
  /** Reason shown when the pattern matches in the title (defaults to `${reason} (title)`). */
  titleReason: z.string().optional(),
});
export type ScoringRuleConfig = z.infer<typeof ScoringRuleSchema>;

const PenaltySchema = z.object({
  pattern: z.string().min(1),
  flags: z.string().default("i"),
  /** Negative number. */
  weight: z.number(),
  /** May contain a `{location}` placeholder, replaced with the job's location. */
  reason: z.string().min(1),
});

const CompanyBoardSchema = z.object({
  slug: z.string().min(1),
  name: z.string().min(1),
});
export type CompanyBoardConfig = z.infer<typeof CompanyBoardSchema>;

/**
 * ATS platforms the Company Watch feature (lib/sources/ats/) knows how to
 * poll. Greenhouse and Lever reuse the existing board fetchers (see
 * lib/sources/companies.ts's mergeCompanyBoards); the other six are new
 * adapters, one file each under lib/sources/ats/.
 */
export const ATS_IDS = [
  "greenhouse",
  "lever",
  "smartrecruiters",
  "ashby",
  "workable",
  "recruitee",
  "personio",
  "workday",
] as const;
export type AtsId = (typeof ATS_IDS)[number];

/**
 * Contract types `sources.franceTravail.contractTypes` (and the matching
 * `searchCriteria.contractTypes` / Settings checkboxes) accept. This app's
 * own vocabulary, not France Travail's raw codes, so the same list drives
 * both the UI and the fetcher (lib/sources/francetravail.ts):
 *
 *   cdi/cdd/interim -> the `typeContrat` facet (CDI/CDD/MIS)
 *   alternance      -> the `natureContrat` facet (E2 apprentissage, FS
 *                       contrat de professionnalisation) - alternance has no
 *                       `typeContrat` code of its own, confirmed against
 *                       France Travail's own /referentiel/typesContrats.
 *   stage           -> NOT representable. Confirmed against both
 *                       /referentiel/typesContrats and
 *                       /referentiel/naturesContrats (12 and 19 codes
 *                       respectively, live-queried): neither lists anything
 *                       for internships. Kept in this list for UI parity
 *                       (the checkbox exists so the gap is visible rather
 *                       than silently missing) but the fetcher sends no
 *                       request for it - see francetravail.ts.
 */
export const FRANCE_TRAVAIL_CONTRACT_TYPES = ["cdi", "cdd", "interim", "alternance", "stage"] as const;
export type FranceTravailContractType = (typeof FRANCE_TRAVAIL_CONTRACT_TYPES)[number];

/**
 * One company an account has asked to watch, added by pasting its career
 * page URL (lib/sources/ats/detect.ts identifies `ats` + `board` from it).
 * `board` is the ATS-specific identifier the adapter's endpoint needs - a
 * plain slug for most ATSs, `"<tenant>/<wdNumber>/<site>"` for Workday and
 * `"<subdomain>.<tld>"` for Personio (both encode more than one piece of the
 * URL into this one field rather than growing the schema per-ATS).
 */
const WatchedCompanySchema = z.object({
  id: z.string().min(1),
  url: z.string().min(1),
  ats: z.enum(ATS_IDS),
  board: z.string().min(1),
  label: z.string().min(1),
  addedAt: z.string().default(() => new Date().toISOString()),
});
export type WatchedCompanyConfig = z.infer<typeof WatchedCompanySchema>;

// ---------------------------------------------------------------------------
// Defaults
//
// These mirror `jobblast.config.example.json`. They are deliberately a
// working, opinionated starting point (an embedded / C++ / systems profile
// looking in France, Taiwan and Japan) rather than an empty shell, so the
// app does something useful out of the box - but they are meant to be
// replaced. See docs/CONFIG.md.
// ---------------------------------------------------------------------------

const DEFAULT_SCORING_RULES: ScoringRuleConfig[] = [
  { pattern: "c\\+\\+", flags: "i", skill: "C++", weight: 18, reason: "C++ mentioned in the posting", titleReason: "C++ mentioned in the title" },
  {
    pattern: "\\b(dds|rti connext|connext|opensplice|cyclone ?dds|data distribution service)\\b",
    flags: "i",
    skill: "DDS",
    weight: 22,
    reason: "DDS middleware (OpenSplice/RTI Connext/Cyclone) mentioned",
    titleReason: "DDS middleware mentioned in the title",
  },
  {
    // 嵌入式 = embedded, 韌體 = firmware, so Taiwanese listings score fairly.
    pattern: "\\b(embedded|embarqu[ée]s?|firmware)\\b|嵌入式|韌體",
    flags: "i",
    skill: "Embedded systems",
    weight: 14,
    reason: "Embedded systems / firmware mentioned",
    titleReason: "Embedded/firmware role in the title",
  },
  { pattern: "\\b(linux|ubuntu)\\b", flags: "i", skill: "Linux", weight: 8, reason: "Linux stack mentioned" },
  { pattern: "\\bcmake\\b", flags: "i", skill: "CMake", weight: 6, reason: "CMake mentioned" },
  { pattern: "\\bpython\\b", flags: "i", skill: "Python", weight: 6, reason: "Python mentioned" },
  { pattern: "\\bdocker\\b", flags: "i", skill: "Docker", weight: 4, reason: "Docker mentioned" },
  { pattern: "\\b(react|typescript)\\b", flags: "i", skill: "React/TypeScript", weight: 6, reason: "React/TypeScript mentioned" },
  {
    // 影像 = image/vision.
    pattern: "\\b(computer vision|opencv|yolo|tensorflow|deep learning|object detection)\\b|影像",
    flags: "i",
    skill: "Computer vision",
    weight: 10,
    reason: "Computer vision (OpenCV/YOLO/TensorFlow/object detection) mentioned",
    titleReason: "Computer vision in the title",
  },
  { pattern: "\\bmiddleware\\b", flags: "i", skill: "Middleware", weight: 8, reason: "Middleware mentioned" },
  {
    pattern: "\\b(junior|graduate|d[ée]butant|entry.level|jeune diplôm[ée])\\b",
    flags: "i",
    skill: "Junior-friendly",
    weight: 8,
    reason: "Open to junior / entry-level profiles",
  },
  {
    pattern: "\\b(english[- ]speaking|no japanese required|english level|anglais courant)\\b",
    flags: "i",
    skill: "English-speaking team",
    weight: 6,
    reason: "English-speaking working environment",
  },
  {
    pattern: "\\b(nlp|natural language processing|llm|large language model|semantic embedding)\\b",
    flags: "i",
    skill: "NLP/LLM",
    weight: 8,
    reason: "NLP / LLM mentioned",
  },
  {
    pattern: "\\b(systemd|debian packag(?:e|ing)|multithread(?:ed|ing)?|real-?time systems?)\\b",
    flags: "i",
    skill: "Systems programming",
    weight: 6,
    reason: "Systems programming (systemd/real-time/multithreading) mentioned",
  },
  {
    pattern: "\\bdistributed systems?\\b",
    flags: "i",
    skill: "Distributed systems",
    weight: 10,
    reason: "Distributed systems mentioned",
    titleReason: "Distributed systems in the title",
  },
  { pattern: "\\bc#\\b", flags: "i", skill: "C#", weight: 5, reason: "C# mentioned" },
  { pattern: "\\breact native\\b", flags: "i", skill: "React Native", weight: 5, reason: "React Native mentioned" },
  { pattern: "\\b(postgresql|postgres|mysql)\\b", flags: "i", skill: "PostgreSQL/MySQL", weight: 4, reason: "PostgreSQL/MySQL mentioned" },
  { pattern: "\\bpower ?bi\\b", flags: "i", skill: "Power BI", weight: 3, reason: "Power BI mentioned" },
  { pattern: "\\b(etl|talend)\\b", flags: "i", skill: "ETL/Talend", weight: 3, reason: "ETL/Talend mentioned" },
  { pattern: "\\bollama\\b", flags: "i", skill: "Ollama/local LLM tooling", weight: 6, reason: "Ollama / local LLM tooling mentioned" },
  { pattern: "\\bbash\\b", flags: "i", skill: "Bash", weight: 4, reason: "Bash scripting mentioned" },
  // 軟體工程師 = "software engineer" (Chinese only - a bare English match
  // would inflate nearly every English posting's score).
  { pattern: "軟體工程師", flags: "", skill: "Software engineer role (TW)", weight: 6, reason: "Software engineer role (軟體工程師) mentioned" },
];

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const ContactSchema = z
  .object({
    /** Used in the cover letter PDF header and as the AI sign-off name. */
    name: z.string().default("Your Name"),
    /** Used in the PDF header and in the outbound HTTP User-Agent. */
    email: z.string().default(""),
    phone: z.string().default(""),
    city: z.string().default(""),
  })
  .default({});

const CandidateSchema = z
  .object({
    /** ISO 639-1 code. Also drives the cover letter PDF's date formatting. */
    nativeLanguage: z.string().default("en"),
    /** Languages the candidate can credibly write an application in. */
    letterLanguages: z.array(z.string()).default(["en"]),
    /** Language used when the posting's language isn't in `letterLanguages`. */
    fallbackLetterLanguage: z.string().default("en"),
  })
  .default({});

const ScoringSchema = z
  .object({
    rules: z.array(ScoringRuleSchema).default(DEFAULT_SCORING_RULES),
    locationBonus: z.number().default(10),
    /** May contain a `{location}` placeholder. */
    locationBonusReason: z.string().default("Target location matched ({location})"),
    /** Highest score any job can reach. */
    scoreCap: z.number().default(98),
    /**
     * Lowercased substrings matched against a posting's location field.
     * Leave empty to derive them from the DB profile's `targetLocations`.
     */
    targetLocationKeywords: z.array(z.string()).default([]),
    /**
     * Broader "close enough to be actionable" location test used by the
     * off-site penalty. Null => fall back to `targetLocationKeywords`.
     */
    targetishLocationPattern: RegexSpecSchema.nullable().default(null),
    remoteSignalPattern: RegexSpecSchema.default({
      pattern: "\\bremote\\b|télétravail|teletravail|work from home|\\banywhere\\b|full[- ]remote",
      flags: "i",
    }),
    penalties: z
      .object({
        workAuthorization: PenaltySchema.default({
          pattern:
            "u\\.?s\\.?\\s+citizens?|green\\s?card|\\bw-?2\\b|authorized to work in the (?:u\\.?s\\.?a?\\.?|united states)|us work authorization|(?:unable|not able) to sponsor|no (?:visa |new )?(?:visa )?sponsorship|h-?1b (?:transfer|holders?)|security clearance|\\bts\\/sci\\b|\\bus persons?\\b",
          flags: "i",
          weight: -40,
          reason: "⚠ US work-authorization restriction (citizens/green card/W2/no sponsorship)",
        }),
        seniorYears: PenaltySchema.default({
          pattern:
            "\\b(?:[5-9]|1[0-9])\\s*(?:\\+|à \\d+|-\\d+)?\\s*(?:years?|yrs?|ans)\\b.{0,50}(?:experience|expérience)|(?:experience|expérience)\\D{0,30}\\b(?:[5-9]|1[0-9])\\s*\\+?\\s*(?:years?|yrs?|ans)\\b",
          flags: "i",
          weight: -20,
          reason: "⚠ Requires 5+ years of experience",
        }),
        /** Tested against the title only. */
        seniorTitle: PenaltySchema.default({
          pattern: "\\b(senior|principal|staff|lead)\\b",
          flags: "i",
          weight: -18,
          reason: "⚠ Senior/staff/lead role in the title",
        }),
        usLocation: PenaltySchema.default({
          pattern: "\\b(?:united states|usa|u\\.s\\.)\\b",
          flags: "i",
          weight: -15,
          reason: "⚠ US location outside the target areas",
        }),
        /** No pattern: applies when a posting is neither target-ish nor remote. */
        offsiteNonTarget: z
          .object({
            weight: z.number().default(-25),
            reason: z.string().default("⚠ On-site outside the target areas ({location})"),
          })
          .default({}),
      })
      .default({}),
    /** Listings scoring below this are dropped instead of queued for review. */
    minRelevanceScore: z.number().default(30),
  })
  .default({});

const SourcesSchema = z
  .object({
    franceTravail: z
      .object({
        enabled: z.boolean().default(true),
        keywords: z.array(z.string()).default(["C++", "embarqué", "développeur logiciel C++", "computer vision"]),
        /** French département codes, e.g. ["75", "92"]. */
        departements: z.array(z.string()).default(["75", "92", "78", "91", "94"]),
        /**
         * Contract types to filter for - see FRANCE_TRAVAIL_CONTRACT_TYPES
         * above. Empty = no filter, every contract type (today's default,
         * unchanged).
         */
        contractTypes: z.array(z.enum(FRANCE_TRAVAIL_CONTRACT_TYPES)).default([]),
        /**
         * Optional hard experience filter - France Travail's own
         * `experience` facet ("1" moins d'un an, "2" 1 à 3 ans, "3" plus de
         * 3 ans; confirmed against the live API). This EXCLUDES results
         * outright, unlike scoring's soft seniorYears/seniorTitle penalties
         * (which only dock points) - so it is deliberately not a UI
         * checkbox, stays opt-in via this config file, and defaults to
         * unset so behavior is unchanged unless a user asks for it.
         */
        experienceLevel: z.enum(["1", "2", "3"]).nullable().default(null),
      })
      .default({}),
    adzuna: z
      .object({
        enabled: z.boolean().default(true),
        /** Adzuna country code in the API path (fr, gb, us, ...). */
        country: z.string().default("fr"),
        queries: z.array(z.string()).default(["développeur C++", "ingénieur logiciel embarqué", "computer vision"]),
        where: z.string().default("Paris"),
        resultsPerPage: z.number().int().positive().default(50),
      })
      .default({}),
    // Jooble (lot H3): free-key aggregator, same "enabled but skipped
    // without a key" pattern as Adzuna above. One POST per keyword.
    jooble: z
      .object({
        enabled: z.boolean().default(true),
        queries: z.array(z.string()).default(["développeur C++", "ingénieur logiciel embarqué", "computer vision"]),
        location: z.string().default("Paris"),
        resultsPerPage: z.number().int().positive().default(20),
      })
      .default({}),
    // Careerjet (lot H3): free-affid affiliate API, same pattern. One GET
    // per keyword.
    careerjet: z
      .object({
        enabled: z.boolean().default(true),
        queries: z.array(z.string()).default(["développeur C++", "ingénieur logiciel embarqué", "computer vision"]),
        location: z.string().default("Paris"),
        pageSize: z.number().int().positive().default(20),
      })
      .default({}),
    greenhouse: z
      .object({
        enabled: z.boolean().default(true),
        boards: z.array(CompanyBoardSchema).default([
          { slug: "appier", name: "Appier" },
          { slug: "datadog", name: "Datadog" },
          { slug: "algolia", name: "Algolia" },
          { slug: "doctolib", name: "Doctolib" },
          { slug: "scandit", name: "Scandit" },
          { slug: "agilityrobotics", name: "Agility Robotics" },
          { slug: "gitai", name: "GITAI" },
        ]),
      })
      .default({}),
    lever: z
      .object({
        enabled: z.boolean().default(true),
        boards: z.array(CompanyBoardSchema).default([
          { slug: "qonto", name: "Qonto" },
          { slug: "swile", name: "Swile" },
        ]),
      })
      .default({}),
    remoteok: z
      .object({
        enabled: z.boolean().default(true),
        tags: z.array(z.string()).default(["cplusplus", "embedded"]),
      })
      .default({}),
    remotive: z
      .object({
        enabled: z.boolean().default(true),
        category: z.string().default("software-dev"),
        search: z.string().default("c++"),
        limit: z.number().int().positive().default(50),
      })
      .default({}),
    himalayas: z
      .object({
        enabled: z.boolean().default(true),
        queries: z.array(z.string()).default(["c++", "embedded", "computer vision"]),
        limit: z.number().int().positive().default(20),
      })
      .default({}),
    yourator: z
      .object({
        enabled: z.boolean().default(true),
        pages: z.array(z.number().int().positive()).default([1, 2, 3]),
        /** Client-side pre-filter; scoring.ts still does the real relevance work. */
        relevanceFilter: RegexSpecSchema.default({
          pattern:
            "(c\\+\\+|embedded|firmware|linux|backend|software engineer|computer vision|opencv|machine learning|devops|full[- ]?stack|工程師|軟體|嵌入式|韌體|後端|影像|演算法|resear?ch engineer)",
          flags: "i",
        }),
      })
      .default({}),
    tokyodev: z.object({ enabled: z.boolean().default(true) }).default({}),
    japandev: z.object({ enabled: z.boolean().default(true) }).default({}),
    arbeitnow: z.object({ enabled: z.boolean().default(true) }).default({}),
    job104: z
      .object({
        // Off by default: 104.com.tw's search endpoint sits behind Cloudflare
        // bot protection and returns zero jobs (see sources/job104.ts).
        enabled: z.boolean().default(false),
        queries: z.array(z.string()).default(["C++", "嵌入式", "軟體工程師"]),
        /** 104 area codes: 6001001000 Taipei, 6001002000 New Taipei, 6001016000 Kaohsiung. */
        areaCodes: z.array(z.string()).default(["6001001000", "6001002000", "6001016000"]),
      })
      .default({}),
    aiScout: z
      .object({
        enabled: z.boolean().default(false),
        /** claude.ai MCP connector server names the headless agent may call. */
        allowedConnectors: z
          .array(z.string())
          .default([
            "mcp__claude_ai_Snagajob",
            "mcp__claude_ai_Aquent_Job_Search",
            "mcp__claude_ai_JobDataLake",
            "mcp__claude_ai_Indeed",
          ]),
        /** Optional shortlist of companies to check the career pages of. */
        targetCompanies: z.array(z.string()).default([]),
        /** Optional shortlist of job boards / sites to search. */
        targetSites: z.array(z.string()).default([]),
        maxPostings: z.number().int().positive().default(15),
        effortLevel: z.enum(["low", "medium", "high"]).default("high"),
      })
      .default({}),
    notionInbox: z
      .object({
        enabled: z.boolean().default(false),
        /** e.g. https://app.notion.com/p/<page-id> */
        pageUrl: z.string().default(""),
        /** e.g. collection://<data-source-id> */
        dataSourceUrl: z.string().default(""),
        /** Property names in the Notion database (rename to match yours). */
        properties: z
          .object({
            title: z.string().default("Title"),
            company: z.string().default("Company"),
            url: z.string().default("URL"),
            location: z.string().default("Location"),
            why: z.string().default("Why"),
            source: z.string().default("Source"),
            imported: z.string().default("Imported"),
          })
          .default({}),
      })
      .default({}),
  })
  .default({});

/**
 * Which engine writes the cover letters (and, for the two agent-capable
 * options, drives AI Scout / Notion Inbox).
 *
 * `claude-cli` is the default so an existing install keeps behaving exactly
 * as before when its config file has no `ai` section at all. `none` disables
 * AI entirely: letters fall back to the template, no process is ever spawned
 * and no API is ever called. `ollama` / `lmstudio` are `openai-compatible`
 * with local-server presets applied (see docs/CONFIG.md).
 */
export const AI_PROVIDERS = [
  "none",
  "claude-cli",
  "codex-cli",
  "gemini-cli",
  "anthropic-api",
  "openai-compatible",
  "ollama",
  "lmstudio",
] as const;
export type AiProviderName = (typeof AI_PROVIDERS)[number];

/**
 * The subset of AI_PROVIDERS selectable via BYOK in `saas` mode
 * (docs/SAAS-ARCHITECTURE.md section 5). Everything else needs either a CLI
 * on the machine or a local server, neither of which means anything for a
 * multi-tenant server process.
 */
export const BYOK_PROVIDERS = ["anthropic-api", "openai-compatible"] as const;
export type ByokProviderName = (typeof BYOK_PROVIDERS)[number];

const AiSchema = z
  .object({
    provider: z.enum(AI_PROVIDERS).default("claude-cli"),
    /** Model for the CLI providers that take one directly (`claude --model`). */
    model: z.string().default("sonnet"),
    /** Default per-call timeout. AI Scout and Notion Inbox override it. */
    timeoutMs: z.number().int().positive().default(180_000),
    fitAnalysis: z
      .object({
        /** Whether the fit-analysis pass (lib/ai/fit-analysis.ts) runs at all. */
        enabled: z.boolean().default(true),
      })
      .default({}),
    /**
     * OpenAI Chat Completions-shaped endpoints. Every key is optional: what
     * you leave out comes from the preset for the selected provider
     * (openai-compatible / ollama / lmstudio), so `"provider": "ollama"` on
     * its own is a complete configuration.
     */
    openaiCompatible: z
      .object({
        baseUrl: z.string().optional(),
        /** Env var holding the bearer token. Empty string => send no key. */
        apiKeyEnv: z.string().optional(),
        model: z.string().optional(),
        temperature: z.number().nullable().optional(),
      })
      .default({}),
    anthropicApi: z
      .object({
        model: z.string().default("claude-opus-5"),
        maxTokens: z.number().int().positive().default(4096),
      })
      .default({}),
    codexCli: z
      .object({
        /** Empty => let Codex use its own configured default model. */
        model: z.string().default(""),
        extraArgs: z.array(z.string()).default([]),
      })
      .default({}),
    geminiCli: z
      .object({
        /** Empty => let Gemini use its own configured default model. */
        model: z.string().default(""),
        extraArgs: z.array(z.string()).default([]),
      })
      .default({}),
  })
  .default({});

/**
 * Gmail sync (lib/gmail-sync.ts): reads recruiter mail through a read-only
 * agent pass and moves matching `applications` rows forward.
 *
 * Off by default and deliberately opt-in twice over: it is the only feature
 * in the app that writes to the application tracker on its own, so enabling
 * it is a decision the user makes explicitly, ideally after a `dryRun` cycle.
 */
const GmailSyncSchema = z
  .object({
    enabled: z.boolean().default(false),
    /** Journal every decision, write nothing to the database. */
    dryRun: z.boolean().default(false),
    /** How far back the mailbox search looks (`newer_than:<n>d`). */
    lookbackDays: z.number().int().positive().max(30).default(2),
  })
  .default({});

export const JobBlastConfigSchema = z
  .object({
    // Allows a leading "_comment" key (and any other underscore-prefixed
    // annotation) in the JSON file without failing validation.
    contact: ContactSchema,
    candidate: CandidateSchema,
    scoring: ScoringSchema,
    sources: SourcesSchema,
    /**
     * Company Watch (docs/SAAS-ARCHITECTURE.md-style shared refresh, lot H2):
     * companies this account asked to be watched by career-page URL, one
     * entry per company. Populated via POST /settings/companies, never
     * hand-edited. See lib/sources/ats/.
     */
    watchedCompanies: z.array(WatchedCompanySchema).default([]),
    ai: AiSchema,
    gmailSync: GmailSyncSchema,
    /**
     * Path (absolute, or relative to the repo root) to a plain-text cover
     * letter used as the structural/tonal reference for AI tailoring. When
     * the file is missing, the text of the uploaded cover_letter document is
     * used instead, then a built-in generic template.
     */
    coverLetterTemplatePath: z.string().default("config/cover-letter-template.txt"),
  })
  .passthrough()
  .default({});

export type JobBlastConfig = z.infer<typeof JobBlastConfigSchema>;

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

export const CONFIG_FILENAME = "jobblast.config.json";

/** Absolute path of the config file (override with JOBBLAST_CONFIG). */
export function configPath(): string {
  const override = process.env["JOBBLAST_CONFIG"];
  if (override && override.trim().length > 0) return path.resolve(REPO_ROOT, override.trim());
  return path.join(REPO_ROOT, CONFIG_FILENAME);
}

let cached: JobBlastConfig | null = null;

// ---------------------------------------------------------------------------
// Per-account config (saas)
//
// `loadConfig()` is synchronous and called from a dozen deep call sites, so
// in `saas` it reads a cache the auth middleware fills from `user_settings`
// before any handler runs (see lib/config-store.ts:primeUserConfig). The
// rule that makes this safe: with no ambient user, or no primed entry,
// loadConfig() THROWS. Never a file, never a default, never another
// account's settings.
// ---------------------------------------------------------------------------

/**
 * Bounded, so a long-lived process does not accumulate one entry per account
 * that has ever been served. The capacity is deliberately above the beta
 * account cap (JOBBLAST_MAX_ACCOUNTS, 150 by default), so in practice nothing
 * is evicted between the middleware priming an entry and a handler reading
 * it; past that size the worst case is a `loadConfig()` that throws and one
 * failed request, never another account's settings.
 */
const USER_CONFIG_CAPACITY = 256;

const userConfigs = new BoundedCache<string, JobBlastConfig>(USER_CONFIG_CAPACITY);

/** Fills the per-account cache. Called by lib/config-store.ts, not by routes. */
export function setUserConfig(userId: string, config: JobBlastConfig): void {
  userConfigs.set(userId, config);
}

export function clearUserConfig(userId?: string): void {
  if (userId === undefined) userConfigs.clear();
  else userConfigs.delete(userId);
}

/**
 * One named account's configuration, without asking who is ambient.
 *
 * `loadConfig()` exists because a dozen deep call sites (source fetchers, PDF
 * renderers) cannot reasonably be handed a userId, and the AsyncLocalStorage
 * context is the deliberate compromise for them. Anything that already knows
 * which account it is acting for should use this instead: it cannot read the
 * wrong account's settings because it never consults the context at all.
 *
 * In `selfhosted` there is one account and one file, so the argument is
 * ignored and this is exactly loadConfig().
 */
export function configFor(userId: string): JobBlastConfig {
  if (!IS_SAAS) return loadConfig();
  const config = userConfigs.get(userId);
  if (!config) {
    throw new Error(
      `No configuration primed for user ${userId}. ` +
        "primeUserConfig() must run before anything reads the config.",
    );
  }
  return config;
}

/**
 * Reads, validates and caches the config. Missing file => defaults.
 * Malformed file or invalid schema => throws (fail fast at boot).
 *
 * In `saas` it resolves the ambient account instead of the file.
 */
export function loadConfig(): JobBlastConfig {
  if (IS_SAAS) {
    const userId = currentUserId();
    if (!userId) {
      throw new Error(
        "loadConfig() was called with no ambient user in saas mode. " +
          "Every config read must run inside runWithUser().",
      );
    }
    return configFor(userId);
  }

  if (cached) return cached;

  const file = configPath();
  let raw: string | null = null;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    // No config file: run entirely on the defaults declared above.
    cached = JobBlastConfigSchema.parse({});
    return cached;
  }

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(raw);
  } catch (err) {
    throw new Error(`${file} is not valid JSON: ${(err as Error).message}`);
  }

  const result = JobBlastConfigSchema.safeParse(parsedJson);
  if (!result.success) {
    throw new Error(`${file} failed validation:\n${JSON.stringify(result.error.format(), null, 2)}`);
  }

  cached = result.data;
  return cached;
}

/** Test/CLI hook: forget every cached config so the next load re-reads its source. */
export function resetConfigCache(): void {
  cached = null;
  userConfigs.clear();
}

/** Compiles a `{ pattern, flags }` pair, with a clear error on a bad pattern. */
export function toRegExp(spec: RegexSpec, label: string): RegExp {
  try {
    return new RegExp(spec.pattern, spec.flags);
  } catch (err) {
    throw new Error(`Invalid regular expression for ${label} (${spec.pattern}): ${(err as Error).message}`);
  }
}

/** Resolves `coverLetterTemplatePath` against the repo root. */
export function coverLetterTemplatePath(): string {
  return path.resolve(REPO_ROOT, loadConfig().coverLetterTemplatePath);
}
