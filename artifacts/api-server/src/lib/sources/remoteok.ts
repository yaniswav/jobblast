// RemoteOK API client. Public, no key required.
// Verified live on 2026-08-13: GET https://remoteok.com/api?tags=TAG returns
// a JSON array whose first element is a legal-notice/metadata object (no
// `id`/`position` fields) rather than a job - it must be filtered out.
// `tags=cplusplus` currently returns zero real jobs (just the notice);
// `tags=embedded` returns ~100. Both are queried anyway per the brief so the
// source picks up C++-tagged postings again if/when they exist.

import { loadConfig } from "../config";
import { logger } from "../logger";
import { stripHtml } from "./html";
import { politeFetch } from "./http";
import type { RawJob } from "./types";

const BASE_URL = "https://remoteok.com/api";
// Tags come from `sources.remoteok.tags` in jobblast.config.json.
function tags(): string[] {
  return loadConfig().sources.remoteok.tags;
}

type RemoteOkJob = {
  id?: string;
  position?: string;
  company?: string;
  tags?: string[];
  description?: string;
  location?: string;
  url?: string;
  apply_url?: string;
  salary_min?: number;
  salary_max?: number;
  date?: string;
};

function toPostedDate(date: string | undefined): string {
  const parsed = date ? new Date(date) : new Date();
  if (Number.isNaN(parsed.getTime())) return new Date().toISOString().slice(0, 10);
  return parsed.toISOString().slice(0, 10);
}

function toSalaryRange(min: number | undefined, max: number | undefined): string | null {
  if (!min && !max) return null;
  if (min && max) return `$${min.toLocaleString("en-US")}–$${max.toLocaleString("en-US")}`;
  if (min) return `$${min.toLocaleString("en-US")}+`;
  return `up to $${(max as number).toLocaleString("en-US")}`;
}

async function fetchTag(tag: string): Promise<RemoteOkJob[]> {
  const res = await politeFetch(`${BASE_URL}?tags=${encodeURIComponent(tag)}`);
  if (!res.ok) {
    logger.warn({ tag, status: res.status }, "RemoteOK request failed");
    return [];
  }
  const data = (await res.json()) as unknown;
  if (!Array.isArray(data)) {
    logger.warn({ tag }, "RemoteOK response was not an array");
    return [];
  }
  // First element is always the legal notice/metadata object, not a job.
  return data.filter((entry): entry is RemoteOkJob => Boolean((entry as RemoteOkJob)?.id && (entry as RemoteOkJob)?.position));
}

export async function fetchRemoteOkJobs(): Promise<RawJob[]> {
  const requestedTags = tags();
  const results = await Promise.allSettled(requestedTags.map((tag) => fetchTag(tag)));

  const jobsById = new Map<string, RemoteOkJob>();
  results.forEach((result, index) => {
    if (result.status === "fulfilled") {
      for (const job of result.value) if (job.id) jobsById.set(job.id, job);
    } else {
      logger.warn({ tag: requestedTags[index], err: result.reason }, "RemoteOK tag fetch failed");
    }
  });

  return Array.from(jobsById.values())
    .filter((job) => Boolean(job.url ?? job.apply_url))
    .map((job) => ({
      source: "RemoteOK",
      title: job.position ?? "",
      company: job.company ?? "Company not disclosed",
      location: job.location || "Remote",
      url: (job.url ?? job.apply_url) as string,
      description: job.description ? stripHtml(job.description) : "",
      postedDate: toPostedDate(job.date),
      salaryRange: toSalaryRange(job.salary_min, job.salary_max),
    }));
}
