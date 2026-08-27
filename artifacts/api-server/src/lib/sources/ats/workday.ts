// Workday CXS (Candidate Experience Site) public API client (Company Watch,
// lot H2; keyword-targeted search added lot J3). This is the same JSON
// endpoint the public career page itself calls to render its list - no
// credentials, no scraping.
//
// List: POST .../wday/cxs/<tenant>/<site>/jobs {"limit":20,"offset":0,"searchText":""}.
// Verified live that the server rejects any `limit` above 20 with HTTP 400
// (tried 50 and 100), so pagination is fixed at 20 per page.
// Detail (full description): GET .../wday/cxs/<tenant>/<site><externalPath>,
// bounded the same way as SmartRecruiters (MAX_DETAIL_FETCHES_PER_COMPANY) -
// large employers on Workday routinely have 1000+ open postings (e.g. Thales
// reported 2000+ total on the day this was verified), and a detail call per
// posting is the only way to get the actual job text, not just the title.
//
// `searchText` is the same box the public career page's own search bar
// posts to, and it is a real filter, not a client-side no-op - verified
// live against Thales: `{"searchText":"c++"}` -> total 333 (worldwide),
// `{"searchText":"c++ france"}` -> total 178, `{"searchText":"embedded"}` ->
// total 183, all far more C++/embedded-dense than the untargeted first page
// (which, at 2000+ open postings, is almost entirely unrelated roles in
// whatever order Workday defaults to). Lot J3 uses that: one untargeted page
// per company for general coverage, plus one targeted search per follower
// keyword - see keyword-search.ts for the shared cap/merge logic and this
// file's fetchListing() below for how the two are combined.
//
// Verified live against a real, public, currently-hiring account: Thales
// (tenant "thales", wd3, site "Careers") - see lot H2's report for the exact
// counts. `board` encodes `"<tenant>/<wdNumber>/<site>"` in one string,
// since the config schema keeps one field per watched company.

import { logger } from "../../logger";
import { loadConfig } from "../../config";
import { watchedCompaniesFor } from "../companies";
import { parseRelativePostedOn } from "./dates";
import { stripHtml } from "../html";
import { politeFetch, sleep } from "../http";
import { targetKeywords, mergeTargetedFirst } from "./keyword-search";
import {
  DETAIL_FETCH_DELAY_MS,
  MAX_DETAIL_FETCHES_PER_COMPANY,
  MAX_POSTINGS_PER_COMPANY,
  MAX_TARGETED_PAGES_PER_KEYWORD_WORKDAY,
} from "./limits";
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

/** One page of one `searchText` query. null means "stop paginating this query" (a request error/failure), distinct from an empty-but-successful page. */
async function fetchSearchPage(
  cxsUrl: string,
  board: string,
  searchText: string,
  offset: number,
): Promise<WorkdayJobPosting[] | null> {
  let res: Response;
  try {
    res = await politeFetch(cxsUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ limit: PAGE_SIZE, offset, searchText }),
    });
  } catch (err) {
    logger.warn({ board, searchText, err }, "Workday jobs request errored");
    return null;
  }
  if (!res.ok) {
    logger.warn({ board, searchText, status: res.status }, "Workday jobs request failed");
    return null;
  }
  const page = (await res.json()) as WorkdayListResponse;
  return page.jobPostings;
}

/** Every page of one `searchText` query, up to `maxPages`, stopping as soon as a page comes back shorter than PAGE_SIZE (nothing left to page through) or a request fails. */
async function fetchSearchResults(
  cxsUrl: string,
  board: string,
  searchText: string,
  maxPages: number,
): Promise<WorkdayJobPosting[]> {
  const postings: WorkdayJobPosting[] = [];
  for (let page = 0; page < maxPages; page++) {
    const batch = await fetchSearchPage(cxsUrl, board, searchText, page * PAGE_SIZE);
    if (batch === null) break;
    postings.push(...batch);
    if (batch.length < PAGE_SIZE) break;
  }
  return postings;
}

/**
 * One company's full listing (lot J3): one untargeted page (general
 * coverage - a posting can be relevant without literally containing any
 * follower keyword) plus one targeted search per follower keyword, capped
 * and deduplicated by `externalPath` (Workday's own per-posting identifier -
 * also what buildWorkdayJob turns into the URL), targeted results ordered
 * first. `rawKeywords` is the account's own, un-normalized search keyword
 * list (empty for an instance-watch company, which belongs to no account -
 * see instance-watches.ts).
 */
async function fetchListing(board: string, rawKeywords: readonly string[]): Promise<WorkdayJobPosting[]> {
  const cxsUrl = `${cxsBaseUrl(board)}/jobs`;
  const untargeted = await fetchSearchResults(cxsUrl, board, "", 1);
  const targeted: WorkdayJobPosting[] = [];
  for (const keyword of targetKeywords(rawKeywords)) {
    targeted.push(...(await fetchSearchResults(cxsUrl, board, keyword, MAX_TARGETED_PAGES_PER_KEYWORD_WORKDAY)));
  }
  return mergeTargetedFirst(targeted, untargeted, (posting) => posting.externalPath).slice(
    0,
    MAX_POSTINGS_PER_COMPANY,
  );
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

/**
 * `rawKeywords` defaults to empty (an instance-watch company - see
 * instance-watches.ts's header on why it reads no config), which reduces to
 * exactly the pre-J3 behavior: one untargeted page, nothing targeted.
 */
export async function fetchWorkdayCompany(
  board: string,
  label: string,
  rawKeywords: readonly string[] = [],
): Promise<RawJob[]> {
  const postings = await fetchListing(board, rawKeywords);
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

/**
 * Fetches every watched Workday company, searched with this account's own
 * search keywords (lot J3 - see the file header and keyword-search.ts). One
 * company failing does not fail the rest.
 */
export async function fetchWorkdayJobs(): Promise<RawJob[]> {
  const companies = watchedCompaniesFor("workday");
  const keywords = loadConfig().sources.franceTravail.keywords;
  const results = await Promise.allSettled(companies.map((c) => fetchWorkdayCompany(c.board, c.label, keywords)));
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
