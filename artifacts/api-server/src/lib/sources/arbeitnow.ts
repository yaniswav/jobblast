// Arbeitnow Job Board API client. Public, no key required.
// Docs: https://documenter.getpostman.com/view/9840143/2s93JqTP2p
// Verified live on 2026-08-13: GET
// https://www.arbeitnow.com/api/job-board-api returns { data: [...], links,
// meta } - page 1 only, no keyword filter param on the free endpoint (the
// doc site paginates via `?page=N`, but the brief calls for page 1 only, so
// we don't paginate).
//
// Heavy overlap with the existing Greenhouse/Lever boards is expected - the
// url-based dedup in refresh.ts handles exact re-posts, and the
// title+company soft dedup added to refresh.ts (applied to every source,
// not just this one) catches near-duplicates that get a different URL on
// each board.

import { logger } from "../logger";
import { stripHtml } from "./html";
import { politeFetch } from "./http";
import type { RawJob } from "./types";

const URL = "https://www.arbeitnow.com/api/job-board-api";

type ArbeitnowJob = {
  slug: string;
  company_name?: string;
  title: string;
  description?: string;
  remote?: boolean;
  url: string;
  tags?: string[];
  location?: string;
  created_at?: number;
};

type ArbeitnowResponse = {
  data?: ArbeitnowJob[];
};

function toPostedDate(createdAt: number | undefined): string {
  if (!createdAt) return new Date().toISOString().slice(0, 10);
  // API returns a unix seconds timestamp.
  const date = new Date(createdAt * 1000);
  if (Number.isNaN(date.getTime())) return new Date().toISOString().slice(0, 10);
  return date.toISOString().slice(0, 10);
}

export async function fetchArbeitnowJobs(): Promise<RawJob[]> {
  let res: Response;
  try {
    res = await politeFetch(URL);
  } catch (err) {
    logger.warn({ err }, "Arbeitnow request errored");
    return [];
  }

  if (!res.ok) {
    logger.warn({ status: res.status }, "Arbeitnow request failed");
    return [];
  }

  const data = (await res.json()) as ArbeitnowResponse;
  const jobs = data.data ?? [];

  return jobs.map((job) => ({
    source: "Arbeitnow",
    title: job.title,
    company: job.company_name ?? "Company not disclosed",
    location: job.remote ? `${job.location || "Remote"} (Remote)` : job.location || "",
    url: job.url,
    description: job.description ? stripHtml(job.description) : "",
    postedDate: toPostedDate(job.created_at),
    salaryRange: null,
  }));
}
