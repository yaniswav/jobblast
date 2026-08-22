// Himalayas remote job board API client. Public, no key required.
// Docs: https://himalayas.app/docs/remote-jobs-api
// Verified live on 2026-08-13: GET
// https://himalayas.app/jobs/api/search?q=QUERY&limit=N returns
// { jobs: [...], totalCount, offset, limit, updatedAt, comments }.

import { loadConfig } from "../config";
import { logger } from "../logger";
import { stripHtml } from "./html";
import { politeFetch } from "./http";
import type { RawJob } from "./types";

const BASE_URL = "https://himalayas.app/jobs/api/search";
// Queries and limit come from `sources.himalayas` in jobblast.config.json.
// Keep the query list short - low request volume, same spirit as the other
// keyword-query sources (adzuna.ts, francetravail.ts).
function settings(): { queries: string[]; limit: number } {
  const { queries, limit } = loadConfig().sources.himalayas;
  return { queries, limit };
}

type HimalayasJob = {
  title: string;
  companyName?: string;
  companySlug?: string;
  description?: string;
  excerpt?: string;
  minSalary?: number | null;
  maxSalary?: number | null;
  salaryPeriod?: string | null;
  currency?: string | null;
  locationRestrictions?: string[];
  pubDate?: number;
  applicationLink?: string;
  guid?: string;
};

type HimalayasResponse = {
  jobs?: HimalayasJob[];
};

function toPostedDate(pubDate: number | undefined): string {
  if (!pubDate) return new Date().toISOString().slice(0, 10);
  const date = new Date(pubDate * 1000);
  if (Number.isNaN(date.getTime())) return new Date().toISOString().slice(0, 10);
  return date.toISOString().slice(0, 10);
}

function toSalaryRange(job: HimalayasJob): string | null {
  const { minSalary, maxSalary, currency, salaryPeriod } = job;
  if (!minSalary && !maxSalary) return null;
  const unit = currency ?? "USD";
  const period = salaryPeriod ? `/${salaryPeriod}` : "";
  if (minSalary && maxSalary) return `${minSalary}–${maxSalary} ${unit}${period}`;
  if (minSalary) return `${minSalary}+ ${unit}${period}`;
  return `up to ${maxSalary} ${unit}${period}`;
}

async function searchOnce(query: string, limit: number): Promise<HimalayasJob[]> {
  const params = new URLSearchParams({ q: query, limit: String(limit) });
  const res = await politeFetch(`${BASE_URL}?${params.toString()}`);

  if (res.status === 429) {
    logger.warn({ query }, "Himalayas rate-limited this request (429), skipping");
    return [];
  }
  if (!res.ok) {
    logger.warn({ query, status: res.status }, "Himalayas search request failed");
    return [];
  }

  const data = (await res.json()) as HimalayasResponse;
  return data.jobs ?? [];
}

export async function fetchHimalayasJobs(): Promise<RawJob[]> {
  const { queries, limit } = settings();
  const results = await Promise.allSettled(queries.map((query) => searchOnce(query, limit)));

  const jobsByUrl = new Map<string, HimalayasJob>();
  results.forEach((result, index) => {
    if (result.status === "fulfilled") {
      for (const job of result.value) {
        const url = job.applicationLink ?? job.guid;
        if (url) jobsByUrl.set(url, job);
      }
    } else {
      logger.warn({ query: queries[index], err: result.reason }, "Himalayas query failed");
    }
  });

  return Array.from(jobsByUrl.entries()).map(([url, job]) => ({
    source: "Himalayas",
    title: job.title,
    company: job.companyName ?? "Company not disclosed",
    location: (job.locationRestrictions ?? []).join(", ") || "Remote",
    url,
    description: job.description ? stripHtml(job.description) : (job.excerpt ?? ""),
    postedDate: toPostedDate(job.pubDate),
    salaryRange: toSalaryRange(job),
  }));
}
