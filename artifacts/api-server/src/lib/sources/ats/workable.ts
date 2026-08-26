// Workable public "jobs widget" API client (Company Watch, lot H2). No API
// key required. Docs: https://help.workable.com/hc/en-us/articles/115012771647
//
// `?details=true` is what gets a `description` field into the listing
// response - without it the widget returns titles and metadata only, which
// would starve scoring.ts of anything to match against. Verified live
// against a real, public, currently-hiring account: `usercentrics`
// (https://apply.workable.com/usercentrics) returned 38 postings with full
// HTML descriptions - see lot H2's report. Several large companies keep a
// Workable *account* registered (200 OK) with zero published jobs on it
// (they moved ATS); that is a legitimate empty result, not a failure.

import { logger } from "../../logger";
import { watchedCompaniesFor } from "../companies";
import { toPostedDate } from "./dates";
import { stripHtml } from "../html";
import { politeFetch } from "../http";
import { MAX_POSTINGS_PER_COMPANY } from "./limits";
import type { RawJob } from "../types";

type WorkableJob = {
  title: string;
  shortlink?: string;
  url?: string;
  city?: string;
  state?: string;
  country?: string;
  published_on?: string;
  description?: string;
};

type WorkableAccountResponse = {
  name?: string;
  jobs: WorkableJob[];
};

/** Pure: JSON -> RawJob[]. Exported for the fixture test. */
export function normalizeWorkableJobs(data: WorkableAccountResponse, companyLabel: string): RawJob[] {
  return data.jobs.slice(0, MAX_POSTINGS_PER_COMPANY).map((job) => ({
    source: "ats:workable",
    title: job.title,
    company: companyLabel,
    location: [job.city, job.state, job.country].filter(Boolean).join(", "),
    url: job.shortlink ?? job.url ?? "",
    description: job.description ? stripHtml(job.description) : "",
    postedDate: toPostedDate(job.published_on),
    salaryRange: null,
  }));
}

export async function fetchWorkableCompany(board: string, label: string): Promise<RawJob[]> {
  const url = `https://apply.workable.com/api/v1/widget/accounts/${encodeURIComponent(board)}?details=true`;
  let res: Response;
  try {
    res = await politeFetch(url);
  } catch (err) {
    logger.warn({ board, err }, "Workable account request errored");
    return [];
  }
  if (!res.ok) {
    logger.warn({ board, status: res.status }, "Workable account request failed");
    return [];
  }
  const data = (await res.json()) as WorkableAccountResponse;
  return normalizeWorkableJobs(data, label);
}

/** Fetches every watched Workable company. One company failing does not fail the rest. */
export async function fetchWorkableJobs(): Promise<RawJob[]> {
  const companies = watchedCompaniesFor("workable");
  const results = await Promise.allSettled(companies.map((c) => fetchWorkableCompany(c.board, c.label)));
  const jobs: RawJob[] = [];
  results.forEach((result, index) => {
    if (result.status === "fulfilled") {
      jobs.push(...result.value);
    } else {
      logger.warn({ board: companies[index]?.board, err: result.reason }, "Workable company fetch failed");
    }
  });
  return jobs;
}
