// Ashby public Job Board API client (Company Watch, lot H2). No API key
// required. Docs: https://developers.ashbyhq.com/reference/jobboardsync
//
// Verified live against a real, public, currently-hiring account: `ramp`
// (https://jobs.ashbyhq.com/ramp) returned 135 postings with full
// `descriptionPlain` text and, where the company opted in, a compensation
// summary string - see lot H2's report for the exact count on the day this
// was verified.

import { logger } from "../../logger";
import { watchedCompaniesFor } from "../companies";
import { toPostedDate } from "./dates";
import { politeFetch } from "../http";
import { MAX_POSTINGS_PER_COMPANY } from "./limits";
import type { RawJob } from "../types";

type AshbyCompensation = {
  compensationTierSummary?: string | null;
} | null;

type AshbyJob = {
  id: string;
  title: string;
  location?: string;
  jobUrl: string;
  descriptionPlain?: string | null;
  publishedAt?: string;
  compensation?: AshbyCompensation;
};

type AshbyBoardResponse = {
  jobs: AshbyJob[];
};

/** Pure: JSON -> RawJob[]. Exported for the fixture test. */
export function normalizeAshbyJobs(data: AshbyBoardResponse, companyLabel: string): RawJob[] {
  return data.jobs.slice(0, MAX_POSTINGS_PER_COMPANY).map((job) => ({
    source: "ats:ashby",
    title: job.title,
    company: companyLabel,
    location: job.location ?? "",
    url: job.jobUrl,
    description: job.descriptionPlain?.trim() ?? "",
    postedDate: toPostedDate(job.publishedAt),
    salaryRange: job.compensation?.compensationTierSummary?.trim() || null,
  }));
}

export async function fetchAshbyCompany(board: string, label: string): Promise<RawJob[]> {
  const url = `https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(board)}?includeCompensation=true`;
  let res: Response;
  try {
    res = await politeFetch(url);
  } catch (err) {
    logger.warn({ board, err }, "Ashby board request errored");
    return [];
  }
  if (!res.ok) {
    logger.warn({ board, status: res.status }, "Ashby board request failed");
    return [];
  }
  const data = (await res.json()) as AshbyBoardResponse;
  return normalizeAshbyJobs(data, label);
}

/** Fetches every watched Ashby company. One company failing does not fail the rest. */
export async function fetchAshbyJobs(): Promise<RawJob[]> {
  const companies = watchedCompaniesFor("ashby");
  const results = await Promise.allSettled(companies.map((c) => fetchAshbyCompany(c.board, c.label)));
  const jobs: RawJob[] = [];
  results.forEach((result, index) => {
    if (result.status === "fulfilled") {
      jobs.push(...result.value);
    } else {
      logger.warn({ board: companies[index]?.board, err: result.reason }, "Ashby company fetch failed");
    }
  });
  return jobs;
}
