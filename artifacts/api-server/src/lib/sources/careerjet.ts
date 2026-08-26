// Careerjet affiliate job search API client (lot H3).
// Docs: https://www.careerjet.com/partners/api/ (a free affiliate id -
// "affid" - is what CAREERJET_API_KEY holds here).
//
// Optional aggregator, same "enabled but skipped without a key" pattern as
// Adzuna/Jooble. One GET per keyword (`sources.careerjet.queries`).
//
// Careerjet's contract is written for a real visitor-facing results page:
// `user_ip` / `user_agent` are meant to be the end user's, and `url` the
// page that will show the results. A scheduled background refresh has none
// of those - there is no end user for this specific request. We send the
// most honest stand-ins available: our own polite, identifying User-Agent
// (lib/sources/http.ts, already used by the scraped sources) instead of a
// fake browser string, the loopback address, and this project's public repo
// as the "results page". This is a documented best-effort, not a confirmed
// contract - see docs/CONFIG.md.

import { loadConfig } from "../config";
import { logger } from "../logger";
import { userAgent } from "./http";
import type { RawJob } from "./types";

const API_URL = "https://search.api.careerjet.net/v4/query";
const RESULTS_PAGE_URL = "https://github.com/yaniswav/jobblast";
const PLACEHOLDER_USER_IP = "127.0.0.1";

function settings() {
  const { queries, location, pageSize } = loadConfig().sources.careerjet;
  return { queries, location, pageSize };
}

export type CareerjetJob = {
  title: string;
  company?: string;
  locations?: string;
  description?: string;
  salary?: string;
  date?: string;
  url: string;
};

type CareerjetSearchResponse = {
  type?: string;
  jobs?: CareerjetJob[];
};

function affid(): string | null {
  const key = process.env["CAREERJET_API_KEY"];
  return key && key.trim().length > 0 ? key.trim() : null;
}

function toPostedDate(date: string | undefined): string {
  const parsed = date ? new Date(date) : new Date();
  if (Number.isNaN(parsed.getTime())) return new Date().toISOString().slice(0, 10);
  return parsed.toISOString().slice(0, 10);
}

function toSalaryRange(salary: string | undefined): string | null {
  const text = salary?.trim();
  return text && text.length > 0 ? text : null;
}

/** Pure mapping, tested directly on fixtures (careerjet.test.ts) - no network involved. */
export function normalizeCareerjetJobs(jobs: CareerjetJob[]): RawJob[] {
  return jobs.map((job) => ({
    source: "Careerjet",
    title: job.title,
    company: job.company ?? "Entreprise non communiquée",
    location: job.locations ?? "",
    url: job.url,
    description: job.description ?? "",
    postedDate: toPostedDate(job.date),
    salaryRange: toSalaryRange(job.salary),
  }));
}

async function searchJobs(
  query: string,
  id: string,
  options: { location: string; pageSize: number },
): Promise<CareerjetJob[]> {
  const params = new URLSearchParams({
    affid: id,
    keywords: query,
    location: options.location,
    pagesize: String(options.pageSize),
    user_ip: PLACEHOLDER_USER_IP,
    user_agent: userAgent(),
    url: RESULTS_PAGE_URL,
  });
  const res = await fetch(`${API_URL}?${params.toString()}`, {
    headers: { Accept: "application/json" },
  });
  if (!res.ok) {
    logger.warn({ query, status: res.status }, "Careerjet search request failed");
    return [];
  }
  const data = (await res.json()) as CareerjetSearchResponse;
  if (data.type && data.type !== "JOBS") {
    logger.warn({ query, type: data.type }, "Careerjet search returned no results");
    return [];
  }
  return data.jobs ?? [];
}

export async function fetchCareerjetJobs(): Promise<RawJob[]> {
  const id = affid();
  if (!id) {
    logger.info("Skipping Careerjet: CAREERJET_API_KEY not set");
    return [];
  }

  const { queries, location, pageSize } = settings();
  const results = await Promise.allSettled(
    queries.map((query) => searchJobs(query, id, { location, pageSize })),
  );
  const jobsByUrl = new Map<string, CareerjetJob>();
  results.forEach((result, index) => {
    if (result.status === "fulfilled") {
      for (const job of result.value) jobsByUrl.set(job.url, job);
    } else {
      logger.warn({ query: queries[index], err: result.reason }, "Careerjet query failed");
    }
  });

  return normalizeCareerjetJobs(Array.from(jobsByUrl.values()));
}
