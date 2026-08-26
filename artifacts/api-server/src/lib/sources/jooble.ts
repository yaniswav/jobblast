// Jooble job search API client (lot H3).
// Docs: https://jooble.org/api/about
//
// Optional aggregator, same "enabled but skipped without a key" pattern as
// Adzuna: requires JOOBLE_API_KEY (a free, self-service key from the URL
// above), and contributes zero jobs with a log line when it's unset.
//
// One POST per keyword (`sources.jooble.queries` in jobblast.config.json),
// same fan-out shape as francetravail.ts/adzuna.ts. Jooble resurfaces largely
// the same postings France Travail and Adzuna already cover for a France
// search - refresh.ts's existing URL + title/company dedup is what keeps
// that from duplicating the review queue, not anything source-specific here.

import { loadConfig } from "../config";
import { logger } from "../logger";
import type { RawJob } from "./types";

const API_BASE = "https://jooble.org/api";

function settings() {
  const { queries, location, resultsPerPage } = loadConfig().sources.jooble;
  return { queries, location, resultsPerPage };
}

export type JoobleJob = {
  id?: number;
  title: string;
  location?: string;
  snippet?: string;
  salary?: string;
  source?: string;
  type?: string;
  link: string;
  company?: string;
  updated?: string;
};

type JoobleSearchResponse = {
  totalCount?: number;
  jobs?: JoobleJob[];
};

function apiKey(): string | null {
  const key = process.env["JOOBLE_API_KEY"];
  return key && key.trim().length > 0 ? key.trim() : null;
}

function toPostedDate(updated: string | undefined): string {
  const date = updated ? new Date(updated) : new Date();
  if (Number.isNaN(date.getTime())) return new Date().toISOString().slice(0, 10);
  return date.toISOString().slice(0, 10);
}

function toSalaryRange(salary: string | undefined): string | null {
  const text = salary?.trim();
  return text && text.length > 0 ? text : null;
}

/** Pure mapping, tested directly on fixtures (jooble.test.ts) - no network involved. */
export function normalizeJoobleJobs(jobs: JoobleJob[]): RawJob[] {
  return jobs.map((job) => ({
    source: "Jooble",
    title: job.title,
    company: job.company ?? "Entreprise non communiquée",
    location: job.location ?? "",
    url: job.link,
    description: [job.snippet, job.type].filter(Boolean).join("\n\n"),
    postedDate: toPostedDate(job.updated),
    salaryRange: toSalaryRange(job.salary),
  }));
}

async function searchJobs(
  query: string,
  key: string,
  options: { location: string; resultsPerPage: number },
): Promise<JoobleJob[]> {
  const res = await fetch(`${API_BASE}/${key}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      keywords: query,
      location: options.location,
      ResultOnPage: options.resultsPerPage,
    }),
  });
  if (!res.ok) {
    logger.warn({ query, status: res.status }, "Jooble search request failed");
    return [];
  }
  const data = (await res.json()) as JoobleSearchResponse;
  return data.jobs ?? [];
}

export async function fetchJoobleJobs(): Promise<RawJob[]> {
  const key = apiKey();
  if (!key) {
    logger.info("Skipping Jooble: JOOBLE_API_KEY not set");
    return [];
  }

  const { queries, location, resultsPerPage } = settings();
  const results = await Promise.allSettled(
    queries.map((query) => searchJobs(query, key, { location, resultsPerPage })),
  );
  const jobsByUrl = new Map<string, JoobleJob>();
  results.forEach((result, index) => {
    if (result.status === "fulfilled") {
      for (const job of result.value) jobsByUrl.set(job.link, job);
    } else {
      logger.warn({ query: queries[index], err: result.reason }, "Jooble query failed");
    }
  });

  return normalizeJoobleJobs(Array.from(jobsByUrl.values()));
}
