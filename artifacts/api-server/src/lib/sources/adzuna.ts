// Adzuna job search API client.
// Docs: https://developer.adzuna.com/overview
//
// Requires ADZUNA_APP_ID / ADZUNA_APP_KEY. The trial plan has low rate
// limits, so we deliberately run few queries and never paginate past page 1.

import { loadConfig } from "../config";
import { logger } from "../logger";
import type { RawJob } from "./types";

// Country, queries, `where` and page size come from `sources.adzuna` in
// jobblast.config.json. Keep the query list short - trial plan rate limits
// are tight.
function settings() {
  const { country, queries, where, resultsPerPage } = loadConfig().sources.adzuna;
  return {
    baseUrl: `https://api.adzuna.com/v1/api/jobs/${country}/search/1`,
    queries,
    where,
    resultsPerPage,
  };
}

type AdzunaResult = {
  title: string;
  description?: string;
  redirect_url: string;
  company?: { display_name?: string };
  location?: { display_name?: string };
  contract_time?: string;
  salary_min?: number;
  salary_max?: number;
  created?: string;
};

type AdzunaSearchResponse = {
  results?: AdzunaResult[];
};

function credentials(): { appId: string; appKey: string } | null {
  const appId = process.env["ADZUNA_APP_ID"];
  const appKey = process.env["ADZUNA_APP_KEY"];
  if (!appId || !appKey) return null;
  return { appId, appKey };
}

function toPostedDate(created: string | undefined): string {
  const date = created ? new Date(created) : new Date();
  if (Number.isNaN(date.getTime())) return new Date().toISOString().slice(0, 10);
  return date.toISOString().slice(0, 10);
}

function formatMoney(value: number): string {
  return Math.round(value).toLocaleString("fr-FR");
}

function toSalaryRange(min: number | undefined, max: number | undefined): string | null {
  if (min && max) return `${formatMoney(min)}–${formatMoney(max)} €`;
  if (min) return `${formatMoney(min)}+ €`;
  if (max) return `jusqu'à ${formatMoney(max)} €`;
  return null;
}

// Adzuna's "id" is unique per posting, but we key on redirect_url since the
// id isn't in the fields the brief asked us to consume; the URL is unique
// enough for de-duplication and is what we store as the canonical url.
async function searchJobs(
  query: string,
  appId: string,
  appKey: string,
  options: { baseUrl: string; where: string; resultsPerPage: number },
): Promise<AdzunaResult[]> {
  const params = new URLSearchParams({
    app_id: appId,
    app_key: appKey,
    what: query,
    where: options.where,
    results_per_page: String(options.resultsPerPage),
  });
  const res = await fetch(`${options.baseUrl}?${params.toString()}`, {
    headers: { Accept: "application/json" },
  });
  if (!res.ok) {
    logger.warn({ query, status: res.status }, "Adzuna search request failed");
    return [];
  }
  const data = (await res.json()) as AdzunaSearchResponse;
  return data.results ?? [];
}

export async function fetchAdzunaJobs(): Promise<RawJob[]> {
  const creds = credentials();
  if (!creds) {
    logger.info("Skipping Adzuna: ADZUNA_APP_ID/ADZUNA_APP_KEY not set");
    return [];
  }

  const { baseUrl, queries, where, resultsPerPage } = settings();
  const results = await Promise.allSettled(
    queries.map((query) => searchJobs(query, creds.appId, creds.appKey, { baseUrl, where, resultsPerPage })),
  );
  const jobsByUrl = new Map<string, AdzunaResult>();
  results.forEach((result, index) => {
    if (result.status === "fulfilled") {
      for (const job of result.value) jobsByUrl.set(job.redirect_url, job);
    } else {
      logger.warn({ query: queries[index], err: result.reason }, "Adzuna query failed");
    }
  });

  return Array.from(jobsByUrl.values()).map((job) => ({
    source: "Adzuna",
    title: job.title,
    company: job.company?.display_name ?? "Entreprise non communiquée",
    location: job.location?.display_name ?? "",
    url: job.redirect_url,
    description: [job.description, job.contract_time].filter(Boolean).join("\n\n"),
    postedDate: toPostedDate(job.created),
    salaryRange: toSalaryRange(job.salary_min, job.salary_max),
  }));
}
