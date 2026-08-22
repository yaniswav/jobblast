// Remotive remote job board API client. Public, no key required.
// Docs: https://remotive.com/api/remote-jobs
//
// STRICT etiquette: Remotive documents a recommended max of ~4 calls/day.
// The refresh cycle runs every 6h (4x/day - see JOB_REFRESH_INTERVAL_MS in
// src/index.ts), so this makes exactly ONE call per refreshJobListings()
// invocation. Do not add more queries/pagination here.
//
// Verified live on 2026-08-13: `category=software-dev` and `search=c%2B%2B`
// did not actually filter the response (identical 18 results returned with
// or without them, and with unrelated titles like "Sales Jedi" mixed in) -
// Remotive's free-tier API currently appears to just return its latest
// jobs regardless of query params. The params are kept in the request as
// documented (in case filtering is restored server-side later), and since
// nothing is filtered client-side either, irrelevant results are simply
// left to score low and get dropped by scoring.ts's MIN_RELEVANCE_SCORE
// threshold, same as any other source's off-topic postings.

import { loadConfig } from "../config";
import { logger } from "../logger";
import { stripHtml } from "./html";
import { politeFetch } from "./http";
import type { RawJob } from "./types";

// Category/search/limit come from `sources.remotive` in jobblast.config.json.
function requestUrl(): string {
  const { category, search, limit } = loadConfig().sources.remotive;
  const params = new URLSearchParams({ category, search, limit: String(limit) });
  return `https://remotive.com/api/remote-jobs?${params.toString()}`;
}

type RemotiveJob = {
  id: number;
  title: string;
  company_name?: string;
  url: string;
  candidate_required_location?: string;
  salary?: string;
  publication_date?: string;
  description?: string;
};

type RemotiveResponse = {
  jobs?: RemotiveJob[];
};

function toPostedDate(publicationDate: string | undefined): string {
  const date = publicationDate ? new Date(publicationDate) : new Date();
  if (Number.isNaN(date.getTime())) return new Date().toISOString().slice(0, 10);
  return date.toISOString().slice(0, 10);
}

function toSalaryRange(salary: string | undefined): string | null {
  if (!salary || salary.trim().length === 0) return null;
  return salary.trim();
}

export async function fetchRemotiveJobs(): Promise<RawJob[]> {
  let res: Response;
  try {
    res = await politeFetch(requestUrl());
  } catch (err) {
    logger.warn({ err }, "Remotive request errored");
    return [];
  }

  if (!res.ok) {
    logger.warn({ status: res.status }, "Remotive request failed");
    return [];
  }

  const data = (await res.json()) as RemotiveResponse;
  const jobs = data.jobs ?? [];

  return jobs.map((job) => ({
    source: "Remotive",
    title: job.title,
    company: job.company_name ?? "Company not disclosed",
    location: job.candidate_required_location || "Remote",
    url: job.url,
    description: job.description ? stripHtml(job.description) : "",
    postedDate: toPostedDate(job.publication_date),
    salaryRange: toSalaryRange(job.salary),
  }));
}
