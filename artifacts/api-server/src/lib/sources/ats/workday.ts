// Workday CXS (Candidate Experience Site) public API client (Company Watch,
// lot H2). This is the same JSON endpoint the public career page itself
// calls to render its list - no credentials, no scraping.
//
// List: POST .../wday/cxs/<tenant>/<site>/jobs {"limit":20,"offset":0,"searchText":""}.
// Verified live that the server rejects any `limit` above 20 with HTTP 400
// (tried 50 and 100), so pagination is fixed at 20 per page, capped by
// MAX_POSTINGS_PER_COMPANY overall (10 pages for the default 200 cap).
// Detail (full description): GET .../wday/cxs/<tenant>/<site><externalPath>,
// bounded the same way as SmartRecruiters (MAX_DETAIL_FETCHES_PER_COMPANY) -
// large employers on Workday routinely have 1000+ open postings (e.g. Thales
// reported 2000 total on the day this was verified), and a detail call per
// posting is the only way to get the actual job text, not just the title.
//
// Verified live against a real, public, currently-hiring account: Thales
// (tenant "thales", wd3, site "Careers") - see lot H2's report for the exact
// counts. `board` encodes `"<tenant>/<wdNumber>/<site>"` in one string,
// since the config schema keeps one field per watched company.

import { logger } from "../../logger";
import { watchedCompaniesFor } from "../companies";
import { parseRelativePostedOn } from "./dates";
import { stripHtml } from "../html";
import { politeFetch, sleep } from "../http";
import { DETAIL_FETCH_DELAY_MS, MAX_DETAIL_FETCHES_PER_COMPANY, MAX_POSTINGS_PER_COMPANY } from "./limits";
import type { RawJob } from "../types";

type WorkdayJobPosting = {
  title: string;
  externalPath: string;
  locationsText?: string;
  postedOn?: string;
};

type WorkdayListResponse = {
  jobPostings: WorkdayJobPosting[];
};

type WorkdayJobDetail = {
  jobPostingInfo?: {
    jobDescription?: string;
  };
};

const PAGE_SIZE = 20;

/** `"<tenant>/<wdNumber>/<site>"` -> the three pieces the endpoints need. */
export function parseWorkdayBoard(board: string) {
  const [tenant, wdNumber, ...rest] = board.split("/");
  const site = rest.join("/");
  if (!tenant || !wdNumber || !site) {
    throw new Error(`Invalid Workday board identifier "${board}" (expected "<tenant>/<wdNumber>/<site>")`);
  }
  return { tenant, wdNumber, site };
}

/** The public career-page origin for one board, e.g. https://thales.wd3.myworkdayjobs.com/Careers. */
function careerPageUrl(board: string): string {
  const { tenant, wdNumber, site } = parseWorkdayBoard(board);
  return `https://${tenant}.${wdNumber}.myworkdayjobs.com/${site}`;
}

/** The CXS API base for one board, e.g. https://thales.wd3.myworkdayjobs.com/wday/cxs/thales/Careers. */
function cxsBaseUrl(board: string): string {
  const { tenant, wdNumber, site } = parseWorkdayBoard(board);
  return `https://${tenant}.${wdNumber}.myworkdayjobs.com/wday/cxs/${tenant}/${site}`;
}

/** Pure: one listing entry (+ optional detail text) -> a RawJob. Exported for the fixture test. */
export function buildWorkdayJob(
  posting: WorkdayJobPosting,
  companyLabel: string,
  board: string,
  descriptionHtml: string | null,
): RawJob {
  return {
    source: "ats:workday",
    title: posting.title,
    company: companyLabel,
    location: posting.locationsText ?? "",
    url: `${careerPageUrl(board)}${posting.externalPath}`,
    description: descriptionHtml ? stripHtml(descriptionHtml) : "",
    postedDate: parseRelativePostedOn(posting.postedOn),
    salaryRange: null,
  };
}

async function fetchListing(board: string): Promise<WorkdayJobPosting[]> {
  const cxsUrl = `${cxsBaseUrl(board)}/jobs`;
  const postings: WorkdayJobPosting[] = [];
  for (let offset = 0; offset < MAX_POSTINGS_PER_COMPANY; offset += PAGE_SIZE) {
    let res: Response;
    try {
      res = await politeFetch(cxsUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ limit: PAGE_SIZE, offset, searchText: "" }),
      });
    } catch (err) {
      logger.warn({ board, err }, "Workday jobs request errored");
      break;
    }
    if (!res.ok) {
      logger.warn({ board, status: res.status }, "Workday jobs request failed");
      break;
    }
    const page = (await res.json()) as WorkdayListResponse;
    postings.push(...page.jobPostings);
    if (page.jobPostings.length < PAGE_SIZE) break;
  }
  return postings.slice(0, MAX_POSTINGS_PER_COMPANY);
}

async function fetchDetail(board: string, externalPath: string): Promise<string | null> {
  try {
    const res = await politeFetch(`${cxsBaseUrl(board)}${externalPath}`);
    if (!res.ok) {
      logger.warn({ board, externalPath, status: res.status }, "Workday job detail request failed");
      return null;
    }
    const detail = (await res.json()) as WorkdayJobDetail;
    return detail.jobPostingInfo?.jobDescription ?? null;
  } catch (err) {
    logger.warn({ board, externalPath, err }, "Workday job detail request errored");
    return null;
  }
}

export async function fetchWorkdayCompany(board: string, label: string): Promise<RawJob[]> {
  const postings = await fetchListing(board);
  const jobs: RawJob[] = [];
  let detailCalls = 0;
  for (const posting of postings) {
    let description: string | null = null;
    if (detailCalls < MAX_DETAIL_FETCHES_PER_COMPANY) {
      detailCalls++;
      description = await fetchDetail(board, posting.externalPath);
      await sleep(DETAIL_FETCH_DELAY_MS);
    }
    jobs.push(buildWorkdayJob(posting, label, board, description));
  }
  return jobs;
}

/** Fetches every watched Workday company. One company failing does not fail the rest. */
export async function fetchWorkdayJobs(): Promise<RawJob[]> {
  const companies = watchedCompaniesFor("workday");
  const results = await Promise.allSettled(companies.map((c) => fetchWorkdayCompany(c.board, c.label)));
  const jobs: RawJob[] = [];
  results.forEach((result, index) => {
    if (result.status === "fulfilled") {
      jobs.push(...result.value);
    } else {
      logger.warn({ board: companies[index]?.board, err: result.reason }, "Workday company fetch failed");
    }
  });
  return jobs;
}
