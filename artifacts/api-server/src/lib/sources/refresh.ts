// Orchestrates a full job aggregation refresh for one account: fetch every
// source, score against the profile, normalize into shared `postings` rows,
// drop the ones this account already has (by url or by normalized
// title+company) or that score too low to be worth reviewing, and attach the
// rest to the account's review queue.
//
// The advert itself lands in the shared pool; only the score, status and
// generated content are per account (see lib/repo/postings.ts).

import type { InsertPosting } from "@workspace/db";
import { loadConfig } from "../config";
import { logger } from "../logger";
import { fetchAdzunaJobs } from "./adzuna";
import { fetchAiScoutJobs } from "./aiscout";
import { fetchArbeitnowJobs } from "./arbeitnow";
import { fetchAshbyJobs } from "./ats/ashby";
import { fetchPersonioJobs } from "./ats/personio";
import { fetchRecruiteeJobs } from "./ats/recruitee";
import { fetchSmartRecruitersJobs } from "./ats/smartrecruiters";
import { fetchWorkableJobs } from "./ats/workable";
import { fetchWorkdayJobs } from "./ats/workday";
import { fetchFranceTravailJobs } from "./francetravail";
import { fetchGreenhouseJobs } from "./greenhouse";
import { fetchHimalayasJobs } from "./himalayas";
import { fetchJapanDevJobs } from "./japandev";
import { fetch104Jobs } from "./job104";
import { fetchLeverJobs } from "./lever";
import { fetchNotionInboxJobs } from "./notion-inbox";
import { fetchRemoteOkJobs } from "./remoteok";
import { fetchRemotiveJobs } from "./remotive";
import {
  addUserPostings,
  attachUserPostings,
  findPostingsByUrl,
  listPostingsToScore,
  listUserTitleCompanyKeys,
  upsertPostings,
  type AttachedPosting,
  type NewUserPosting,
} from "../repo/postings";
import { getProfile } from "../repo/profile";
import { locationKeywordsFromProfile, scoreJob } from "./scoring";
import { SOURCE_IDS, type SourceId } from "./signature";
import { coverLetterFor, getCoverLetterTemplate, tailoredBulletsFor, type BulletProfile } from "./tailoring";
import { fetchTokyoDevJobs } from "./tokyodev";
import type { RawJob, ScoredJob } from "./types";
import { fetchYouratorJobs } from "./yourator";

const NO_SALARY_TEXT = "Not disclosed";

const REMOTE_PATTERN = /\b(remote|télétravail|à distance|full remote|100% remote)\b/i;
const HYBRID_PATTERN = /\b(hybrid|hybride)\b/i;

function detectWorkMode(job: RawJob): "Remote" | "Hybrid" | "On-site" {
  const text = `${job.title} ${job.location} ${job.description}`;
  if (HYBRID_PATTERN.test(text)) return "Hybrid";
  if (REMOTE_PATTERN.test(text)) return "Remote";
  return "On-site";
}

function companyInitials(company: string): string {
  const words = company.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return "??";
  if (words.length === 1) return words[0]!.slice(0, 2).toUpperCase();
  return `${words[0]![0]}${words[1]![0]}`.toUpperCase();
}

/** Everything toInsertRow needs that isn't on the job itself. */
type TailoringContext = {
  profile: BulletProfile;
  coverLetterTemplate: string;
};

/** The shared-pool half of a fetched listing: the advert, with nothing per account on it. */
function toPosting(job: RawJob): InsertPosting {
  return {
    source: job.source,
    title: job.title,
    company: job.company,
    companyInitials: companyInitials(job.company),
    location: job.location || "Location not specified",
    workMode: detectWorkMode(job),
    url: job.url,
    description: job.description || `${job.company} is hiring for ${job.title}.`,
    postedDate: job.postedDate,
    salaryRange: job.salaryRange ?? NO_SALARY_TEXT,
    titleCompanyKey: titleCompanyKey(job.title, job.company),
  };
}

function toNewUserPosting(job: ScoredJob, ctx: TailoringContext): NewUserPosting {
  return {
    posting: toPosting(job),
    relevanceScore: job.relevanceScore,
    matchReasons: job.matchReasons,
    highlightedSkills: job.highlightedSkills,
    tailoredBullets: tailoredBulletsFor(job.highlightedSkills, ctx.profile),
    coverLetter: coverLetterFor(job.title, job.company, ctx.coverLetterTemplate),
  };
}

/**
 * Every source, keyed by the id lib/sources/signature.ts uses. Order is the
 * order they are launched in, which matters only for the last two: both are
 * headless agent passes with their own internal throttles, and AI Scout is by
 * far the slowest fetcher.
 *
 *   Notion Inbox - headless agent against a Notion "inbox" database,
 *                  self-throttled to at most once per 3h internally, so it is
 *                  a no-op on most manually-triggered refreshes but always
 *                  runs on the scheduled cycle.
 *   AI Scout     - headless web-search agent, self-throttled to once per 24h.
 */
const SOURCE_FETCHERS = {
  franceTravail: { name: "France Travail", fetch: fetchFranceTravailJobs },
  greenhouse: { name: "Greenhouse", fetch: fetchGreenhouseJobs },
  lever: { name: "Lever", fetch: fetchLeverJobs },
  adzuna: { name: "Adzuna", fetch: fetchAdzunaJobs },
  yourator: { name: "Yourator", fetch: fetchYouratorJobs },
  job104: { name: "104", fetch: fetch104Jobs },
  tokyodev: { name: "TokyoDev", fetch: fetchTokyoDevJobs },
  japandev: { name: "JapanDev", fetch: fetchJapanDevJobs },
  himalayas: { name: "Himalayas", fetch: fetchHimalayasJobs },
  remoteok: { name: "RemoteOK", fetch: fetchRemoteOkJobs },
  remotive: { name: "Remotive", fetch: fetchRemotiveJobs },
  arbeitnow: { name: "Arbeitnow", fetch: fetchArbeitnowJobs },
  notionInbox: { name: "Notion Inbox", fetch: fetchNotionInboxJobs },
  aiScout: { name: "AI Scout", fetch: fetchAiScoutJobs },
  // Company Watch (lot H2): Greenhouse and Lever above already include
  // watched companies via lib/sources/companies.ts; these six are the new
  // ATSs, each fetching only the companies this account asked to watch.
  smartrecruiters: { name: "SmartRecruiters", fetch: fetchSmartRecruitersJobs },
  ashby: { name: "Ashby", fetch: fetchAshbyJobs },
  workable: { name: "Workable", fetch: fetchWorkableJobs },
  recruitee: { name: "Recruitee", fetch: fetchRecruiteeJobs },
  personio: { name: "Personio", fetch: fetchPersonioJobs },
  workday: { name: "Workday", fetch: fetchWorkdayJobs },
} satisfies Record<SourceId, { name: string; fetch: () => Promise<RawJob[]> }>;

/** Runs one source under the ambient account's configuration. */
export function fetchOneSource(source: SourceId): Promise<RawJob[]> {
  return SOURCE_FETCHERS[source].fetch();
}

/** The human-readable name a source is logged under. */
export function sourceDisplayName(source: SourceId): string {
  return SOURCE_FETCHERS[source].name;
}

async function fetchAllSources(): Promise<RawJob[]> {
  // Which sources run is entirely config-driven (`sources.*.enabled` in
  // jobblast.config.json); their query parameters live there too and are
  // read by each fetcher. The six Company Watch ATSs beyond Greenhouse/Lever
  // (lot H2) have no such toggle - they run whenever this account watches at
  // least one company on that ATS.
  const cfg = loadConfig();
  const { sources, watchedCompanies } = cfg;
  const hasWatched = (ats: (typeof watchedCompanies)[number]["ats"]) => watchedCompanies.some((c) => c.ats === ats);
  const enabled = {
    franceTravail: sources.franceTravail.enabled,
    greenhouse: sources.greenhouse.enabled || hasWatched("greenhouse"),
    lever: sources.lever.enabled || hasWatched("lever"),
    adzuna: sources.adzuna.enabled,
    yourator: sources.yourator.enabled,
    job104: sources.job104.enabled,
    tokyodev: sources.tokyodev.enabled,
    japandev: sources.japandev.enabled,
    himalayas: sources.himalayas.enabled,
    remoteok: sources.remoteok.enabled,
    remotive: sources.remotive.enabled,
    arbeitnow: sources.arbeitnow.enabled,
    notionInbox: sources.notionInbox.enabled,
    aiScout: sources.aiScout.enabled,
    smartrecruiters: hasWatched("smartrecruiters"),
    ashby: hasWatched("ashby"),
    workable: hasWatched("workable"),
    recruitee: hasWatched("recruitee"),
    personio: hasWatched("personio"),
    workday: hasWatched("workday"),
  } satisfies Record<SourceId, boolean>;
  const sourceFetchers = SOURCE_IDS.filter((id) => enabled[id]).map((id) => SOURCE_FETCHERS[id]);

  logger.info(
    { sources: sourceFetchers.map((source) => source.name) },
    "Job refresh: fetching enabled sources",
  );

  const results = await Promise.allSettled(sourceFetchers.map((source) => source.fetch()));

  const jobs: RawJob[] = [];
  results.forEach((result, index) => {
    const name = sourceFetchers[index]!.name;
    if (result.status === "fulfilled") {
      logger.info({ source: name, count: result.value.length }, "Job source fetched");
      jobs.push(...result.value);
    } else {
      logger.warn({ source: name, err: result.reason }, "Job source failed, continuing without it");
    }
  });

  return jobs;
}

export type RefreshSummary = {
  fetched: number;
  scored: number;
  belowThreshold: number;
  duplicates: number;
  softDuplicates: number;
  inserted: number;
};

/** Normalizes a title+company pair into a key for the soft (non-URL) dedup
 * pass below - lowercased, trimmed, whitespace-collapsed. Catches the same
 * job posted under a different URL on two different boards (e.g. a listing
 * mirrored by both a Greenhouse board and Arbeitnow). */
function titleCompanyKey(title: string, company: string): string {
  const normalize = (s: string) => s.trim().toLowerCase().replace(/\s+/g, " ");
  return `${normalize(title)}|${normalize(company)}`;
}

// Keyed by account, like the guards in lib/ai/tailor.ts: with one implicit
// account (selfhosted) this is exactly the old single boolean, and with many
// it stops one account's refresh from making every other account's manual
// refresh a silent no-op.
const refreshRunningFor = new Set<string>();

/** True while a refreshJobListings() call is in flight for this account. Lets
 * callers (e.g. the POST /api/jobs/refresh route) avoid piling up overlapping
 * refreshes. */
export function isRefreshRunning(userId: string): boolean {
  return refreshRunningFor.has(userId);
}

/**
 * Fetches every source, scores + normalizes results, and inserts the new,
 * relevant ones. A module-level guard makes overlapping calls a no-op
 * (mirrors the passRunning guard in lib/ai/tailor.ts), returning a
 * zeroed-out summary instead of running a second fetch concurrently.
 */
export async function refreshJobListings(userId: string): Promise<RefreshSummary> {
  if (refreshRunningFor.has(userId)) {
    logger.debug("Job refresh already running, skipping this trigger");
    return { fetched: 0, scored: 0, belowThreshold: 0, duplicates: 0, softDuplicates: 0, inserted: 0 };
  }
  refreshRunningFor.add(userId);

  try {
    const profileRow = await getProfile(userId);
    const profile: BulletProfile = {
      headline: profileRow?.headline ?? "",
      masterResume: profileRow?.masterResume ?? "",
    };
    const profileLocationKeywords = locationKeywordsFromProfile(profileRow?.targetLocations ?? []);
    const coverLetterTemplate = await getCoverLetterTemplate(userId);
    const ctx: TailoringContext = { profile, coverLetterTemplate };

    const rawJobs = await fetchAllSources();
    const scoredJobs = rawJobs.map((job) => scoreJob(job, profileLocationKeywords));

    const minRelevanceScore = loadConfig().scoring.minRelevanceScore;
    const relevant = scoredJobs.filter((job) => job.relevanceScore >= minRelevanceScore);
    const belowThreshold = scoredJobs.length - relevant.length;

    if (relevant.length === 0) {
      logger.info(
        { fetched: rawJobs.length, belowThreshold },
        "Job refresh: no relevant listings found",
      );
      return {
        fetched: rawJobs.length,
        scored: scoredJobs.length,
        belowThreshold,
        duplicates: 0,
        softDuplicates: 0,
        inserted: 0,
      };
    }

    // De-dupe within this batch first (a title can appear in multiple queries
    // for the same source), then against what's already stored.
    const byUrl = new Map<string, ScoredJob>();
    for (const job of relevant) byUrl.set(job.url, job);
    const candidateUrls = Array.from(byUrl.keys());

    // A posting already in the shared pool is only a duplicate for *this*
    // account when the account already has a queue row for it; otherwise it
    // is adopted (and its lastSeenAt refreshed) rather than refetched.
    const existing = await findPostingsByUrl(userId, candidateUrls);
    const existingUrls = new Set(
      existing.filter((row) => row.mine).map((row) => row.url),
    );

    // Soft dedup pass (applies to every source, not just the new ones): the
    // same posting often appears on multiple boards under different URLs
    // (e.g. a Greenhouse listing mirrored by Arbeitnow, or a company posting
    // to both Lever and a curated board). URL dedup above can't catch that,
    // so we also skip a listing whose normalized title+company is already in
    // this account's queue, regardless of which URL it came in on.
    const seenTitleCompanyKeys = new Set(await listUserTitleCompanyKeys(userId));

    const toInsert: NewUserPosting[] = [];
    let softDuplicates = 0;
    for (const [url, job] of byUrl) {
      if (existingUrls.has(url)) continue;
      const key = titleCompanyKey(job.title, job.company);
      if (seenTitleCompanyKeys.has(key)) {
        softDuplicates++;
        continue;
      }
      // Mark as seen immediately so two same-batch listings for the same
      // role (different source, different URL) don't both get inserted.
      seenTitleCompanyKeys.add(key);
      toInsert.push(toNewUserPosting(job, ctx));
    }
    const duplicates = byUrl.size - toInsert.length - softDuplicates;

    const inserted = await addUserPostings(userId, toInsert);

    if (softDuplicates > 0) {
      logger.info({ softDuplicates }, "Job refresh: skipped listings as title+company duplicates");
    }

    const summary: RefreshSummary = {
      fetched: rawJobs.length,
      scored: scoredJobs.length,
      belowThreshold,
      duplicates,
      softDuplicates,
      inserted,
    };
    logger.info(summary, "Job refresh complete");
    return summary;
  } finally {
    refreshRunningFor.delete(userId);
  }
}

// ---------------------------------------------------------------------------
// The shared refresh (saas)
//
// Same pipeline, cut in two along the line docs/SAAS-ARCHITECTURE.md section
// 3.2 draws: the network half runs once per query signature and writes only
// the shared advert pool; the scoring half runs once per account, against
// that account's own configuration. Self-hosted keeps calling
// refreshJobListings() above, which does both in one pass for its one
// account, so nothing about it changes.
// ---------------------------------------------------------------------------

/**
 * Fetches one source once and writes what comes back to the shared pool.
 * Runs under whatever account context the caller established: every
 * subscriber to this signature has identical parameters for this source,
 * which is what the signature means.
 */
export async function fetchSignatureIntoPool(source: SourceId): Promise<{
  fetched: number;
  stored: number;
}> {
  const rawJobs = await fetchOneSource(source);
  if (rawJobs.length === 0) return { fetched: 0, stored: 0 };
  const stored = await upsertPostings(rawJobs.map(toPosting));
  return { fetched: rawJobs.length, stored };
}

export type ScoreSummary = {
  candidates: number;
  belowThreshold: number;
  softDuplicates: number;
  inserted: number;
};

/** How many fresh adverts one `user.score` job looks at. */
const SCORE_BATCH = 500;

/**
 * Scores the adverts this account has not seen yet against its own scoring
 * config and attaches the ones worth reviewing. Idempotent: the candidate
 * query excludes anything already in the account's queue, so re-running
 * after a crash is free.
 */
export async function scorePostingsForUser(userId: string, since: Date): Promise<ScoreSummary> {
  const empty: ScoreSummary = { candidates: 0, belowThreshold: 0, softDuplicates: 0, inserted: 0 };

  const candidates = await listPostingsToScore(userId, since, SCORE_BATCH);
  if (candidates.length === 0) return empty;

  const profileRow = await getProfile(userId);
  const profile: BulletProfile = {
    headline: profileRow?.headline ?? "",
    masterResume: profileRow?.masterResume ?? "",
  };
  const profileLocationKeywords = locationKeywordsFromProfile(profileRow?.targetLocations ?? []);
  const coverLetterTemplate = await getCoverLetterTemplate(userId);
  const minRelevanceScore = loadConfig().scoring.minRelevanceScore;

  const seenTitleCompanyKeys = new Set(await listUserTitleCompanyKeys(userId));

  const toAttach: AttachedPosting[] = [];
  let belowThreshold = 0;
  let softDuplicates = 0;

  for (const candidate of candidates) {
    const raw: RawJob = {
      source: candidate.source as RawJob["source"],
      title: candidate.title,
      company: candidate.company,
      location: candidate.location,
      url: candidate.url,
      description: candidate.description,
      postedDate: candidate.postedDate,
      salaryRange: candidate.salaryRange,
    };
    const scored = scoreJob(raw, profileLocationKeywords);
    if (scored.relevanceScore < minRelevanceScore) {
      belowThreshold++;
      continue;
    }
    if (seenTitleCompanyKeys.has(candidate.titleCompanyKey)) {
      softDuplicates++;
      continue;
    }
    seenTitleCompanyKeys.add(candidate.titleCompanyKey);

    toAttach.push({
      postingId: candidate.id,
      relevanceScore: scored.relevanceScore,
      matchReasons: scored.matchReasons,
      highlightedSkills: scored.highlightedSkills,
      tailoredBullets: tailoredBulletsFor(scored.highlightedSkills, profile),
      coverLetter: coverLetterFor(scored.title, scored.company, coverLetterTemplate),
    });
  }

  const inserted = await attachUserPostings(userId, toAttach);
  const summary: ScoreSummary = {
    candidates: candidates.length,
    belowThreshold,
    softDuplicates,
    inserted,
  };
  logger.info(summary, "Shared refresh: account scored its new postings");
  return summary;
}
