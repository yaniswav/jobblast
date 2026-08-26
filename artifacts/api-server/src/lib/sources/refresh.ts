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
  findPostingsByUrl,
  listUserTitleCompanyKeys,
  type NewUserPosting,
} from "../repo/postings";
import { getProfile } from "../repo/profile";
import { locationKeywordsFromProfile, scoreJob } from "./scoring";
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

function toNewUserPosting(job: ScoredJob, ctx: TailoringContext): NewUserPosting {
  const posting: InsertPosting = {
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
  return {
    posting,
    relevanceScore: job.relevanceScore,
    matchReasons: job.matchReasons,
    highlightedSkills: job.highlightedSkills,
    tailoredBullets: tailoredBulletsFor(job.highlightedSkills, ctx.profile),
    coverLetter: coverLetterFor(job.title, job.company, ctx.coverLetterTemplate),
  };
}

async function fetchAllSources(): Promise<RawJob[]> {
  // Which sources run is entirely config-driven (`sources.*.enabled` in
  // jobblast.config.json); their query parameters live there too and are
  // read by each fetcher.
  const { sources } = loadConfig();
  const sourceFetchers = [
    { name: "France Travail", enabled: sources.franceTravail.enabled, fetch: fetchFranceTravailJobs },
    { name: "Greenhouse", enabled: sources.greenhouse.enabled, fetch: fetchGreenhouseJobs },
    { name: "Lever", enabled: sources.lever.enabled, fetch: fetchLeverJobs },
    { name: "Adzuna", enabled: sources.adzuna.enabled, fetch: fetchAdzunaJobs },
    { name: "Yourator", enabled: sources.yourator.enabled, fetch: fetchYouratorJobs },
    { name: "104", enabled: sources.job104.enabled, fetch: fetch104Jobs },
    { name: "TokyoDev", enabled: sources.tokyodev.enabled, fetch: fetchTokyoDevJobs },
    { name: "JapanDev", enabled: sources.japandev.enabled, fetch: fetchJapanDevJobs },
    { name: "Himalayas", enabled: sources.himalayas.enabled, fetch: fetchHimalayasJobs },
    { name: "RemoteOK", enabled: sources.remoteok.enabled, fetch: fetchRemoteOkJobs },
    { name: "Remotive", enabled: sources.remotive.enabled, fetch: fetchRemotiveJobs },
    { name: "Arbeitnow", enabled: sources.arbeitnow.enabled, fetch: fetchArbeitnowJobs },
    // Headless Claude agent against a Notion "inbox" database -
    // self-throttles to at most once per 3h internally (see
    // notion-inbox.ts), so it's a no-op on most manually-triggered refreshes
    // but always runs on the scheduled 6h cycle.
    { name: "Notion Inbox", enabled: sources.notionInbox.enabled, fetch: fetchNotionInboxJobs },
    // Headless Claude agent, web-search-backed - self-throttles to at most
    // once per 24h internally (see aiscout.ts), so it's a no-op on most
    // refresh cycles. Listed last since it's by far the slowest fetcher.
    { name: "AI Scout", enabled: sources.aiScout.enabled, fetch: fetchAiScoutJobs },
  ].filter((source) => source.enabled);

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

let refreshRunning = false;

/** True while a refreshJobListings() call is in flight. Lets callers (e.g. the
 * POST /api/jobs/refresh route) avoid piling up overlapping refreshes. */
export function isRefreshRunning(): boolean {
  return refreshRunning;
}

/**
 * Fetches every source, scores + normalizes results, and inserts the new,
 * relevant ones. A module-level guard makes overlapping calls a no-op
 * (mirrors the passRunning guard in lib/ai/tailor.ts), returning a
 * zeroed-out summary instead of running a second fetch concurrently.
 */
export async function refreshJobListings(userId: string): Promise<RefreshSummary> {
  if (refreshRunning) {
    logger.debug("Job refresh already running, skipping this trigger");
    return { fetched: 0, scored: 0, belowThreshold: 0, duplicates: 0, softDuplicates: 0, inserted: 0 };
  }
  refreshRunning = true;

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
    refreshRunning = false;
  }
}
