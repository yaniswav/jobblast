// Yourator (Taiwan startup job board) client. No official API docs; this
// consumes the same JSON endpoint the yourator.co website itself calls.
// Endpoint confirmed live via curl on 2026-08-13: GET
// https://www.yourator.co/api/v4/jobs?page=N returns
// { payload: { jobs: [...], hasMore, nextPage, ... } }.
//
// No server-side keyword filter was found: `term=`, `q=`, `query=`, and
// `keyword[]=` were all probed live and returned byte-identical results to
// the unfiltered `?page=1` request (same 20 job ids in the same order), and
// `category[]=` guesses either 404'd or returned zero results. So instead we
// fetch a handful of unfiltered pages and filter client-side by keyword
// before returning - this keeps the request volume low (the brief's "low
// volume" etiquette) while still surfacing the roles that matter, since most
// of Yourator's listings are sales/marketing/design, not engineering.
//
// The job list payload has no description field (only title/tags/salary/
// location), so the RawJob description is synthesized from tags + salary -
// short, but enough for scoring.ts to work with (same tradeoff as
// tokyodev.ts/japandev.ts).

import { loadConfig, toRegExp } from "../config";
import { logger } from "../logger";
import { politeFetch } from "./http";
import type { RawJob } from "./types";

const BASE_URL = "https://www.yourator.co/api/v4/jobs";
const JOB_BASE_URL = "https://www.yourator.co";

// Pages to fetch and the client-side relevance pre-filter come from
// `sources.yourator` in jobblast.config.json. The filter is deliberately
// broader than scoring.ts - it only decides whether a listing is worth
// keeping at all; scoring.ts still does the real relevance scoring.
function settings(): { pages: number[]; relevanceFilter: RegExp } {
  const { pages, relevanceFilter } = loadConfig().sources.yourator;
  return { pages, relevanceFilter: toRegExp(relevanceFilter, "sources.yourator.relevanceFilter") };
}

type YouratorJob = {
  id: number;
  name: string;
  path: string;
  salary?: string;
  location?: string;
  tags?: string[];
  company?: { brand?: string; enName?: string; path?: string };
};

type YouratorResponse = {
  payload?: { jobs?: YouratorJob[] };
};

async function fetchPage(page: number): Promise<YouratorJob[]> {
  const res = await politeFetch(`${BASE_URL}?page=${page}`);
  if (!res.ok) {
    logger.warn({ page, status: res.status }, "Yourator page request failed");
    return [];
  }
  const data = (await res.json()) as YouratorResponse;
  return data.payload?.jobs ?? [];
}

function isRelevant(job: YouratorJob, relevanceFilter: RegExp): boolean {
  const text = `${job.name} ${(job.tags ?? []).join(" ")}`;
  return relevanceFilter.test(text);
}

function toDescription(job: YouratorJob): string {
  const parts = [
    job.tags && job.tags.length > 0 ? `Tags: ${job.tags.join(", ")}` : null,
    job.salary ? `Salary: ${job.salary}` : null,
  ].filter(Boolean);
  return parts.join("\n");
}

export async function fetchYouratorJobs(): Promise<RawJob[]> {
  const { pages, relevanceFilter } = settings();
  const results = await Promise.allSettled(pages.map((page) => fetchPage(page)));

  const jobsById = new Map<number, YouratorJob>();
  results.forEach((result, index) => {
    if (result.status === "fulfilled") {
      for (const job of result.value) jobsById.set(job.id, job);
    } else {
      logger.warn({ page: pages[index], err: result.reason }, "Yourator page fetch failed");
    }
  });

  const relevant = Array.from(jobsById.values()).filter((job) => isRelevant(job, relevanceFilter));

  return relevant.map((job) => ({
    source: "Yourator",
    title: job.name,
    company: job.company?.brand?.trim() || job.company?.enName || "公司未公開",
    location: job.location ?? "",
    url: `${JOB_BASE_URL}${job.path}`,
    description: toDescription(job),
    postedDate: new Date().toISOString().slice(0, 10),
    salaryRange: job.salary ?? null,
  }));
}
