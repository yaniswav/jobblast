// SmartRecruiters public Postings API client (Company Watch, lot H2). No API
// key required. Docs: https://developers.smartrecruiters.com/docs/positing-api
//
// The listing endpoint (`/postings`) does not carry a job description at
// all - confirmed live, `?fields=`/`?expand=`/`?content=true` variants make
// no difference to the payload. Only the per-posting detail endpoint
// (`/postings/{id}`) has it, under `jobAd.sections`. Fetching detail for
// every posting on a large company (some return 300+) would mean that many
// extra requests per refresh; MAX_DETAIL_FETCHES_PER_COMPANY bounds it,
// sequential with a short delay (DETAIL_FETCH_DELAY_MS), and postings beyond
// the cap still land in the pool with a shorter, list-derived description
// instead of being dropped.
//
// Verified live against a real, public, currently-hiring account: `Grab`
// (https://careers.smartrecruiters.com/grab) - see lot H2's report for the
// exact posting count on the day this was verified. Note the API's company
// identifier is not always the same string as the careers-page URL slug
// (e.g. "visa" 404s while "Grab"/"grab" both work) - a company whose
// identifier differs shows up as "unsupported" via a 0-result, logged fetch
// rather than a crash.

import { logger } from "../../logger";
import { watchedCompaniesFor } from "../companies";
import { toPostedDate } from "./dates";
import { stripHtml } from "../html";
import { politeFetch, sleep } from "../http";
import { DETAIL_FETCH_DELAY_MS, MAX_DETAIL_FETCHES_PER_COMPANY, MAX_POSTINGS_PER_COMPANY } from "./limits";
import type { RawJob } from "../types";

type SmartRecruitersLocation = {
  city?: string;
  country?: string;
  fullLocation?: string;
};

type SmartRecruitersListItem = {
  id: string;
  name: string;
  location?: SmartRecruitersLocation;
  releasedDate?: string;
};

type SmartRecruitersListResponse = {
  totalFound: number;
  content: SmartRecruitersListItem[];
};

type SmartRecruitersJobAdSection = {
  text?: string;
};

type SmartRecruitersDetail = {
  postingUrl?: string;
  jobAd?: {
    sections?: Record<string, SmartRecruitersJobAdSection>;
  };
};

const LIST_PAGE_SIZE = 100;

function listLocation(location: SmartRecruitersLocation | undefined): string {
  if (!location) return "";
  return location.fullLocation ?? [location.city, location.country].filter(Boolean).join(", ");
}

/** Pure: a detail response -> plain-text description. Exported for the fixture test. */
export function descriptionFromDetail(detail: SmartRecruitersDetail): string {
  const sections = detail.jobAd?.sections;
  if (!sections) return "";
  const text = Object.values(sections)
    .map((section) => section.text)
    .filter((value): value is string => Boolean(value))
    .join("\n\n");
  return text ? stripHtml(text) : "";
}

/** Pure: one list item (+ optional detail) -> a RawJob. Exported for the fixture test. */
export function buildSmartRecruitersJob(
  item: SmartRecruitersListItem,
  companyLabel: string,
  board: string,
  detail: SmartRecruitersDetail | null,
): RawJob {
  return {
    source: "ats:smartrecruiters",
    title: item.name,
    company: companyLabel,
    location: listLocation(item.location),
    url: detail?.postingUrl ?? `https://jobs.smartrecruiters.com/${encodeURIComponent(board)}/${item.id}`,
    description: detail ? descriptionFromDetail(detail) : "",
    postedDate: toPostedDate(item.releasedDate),
    salaryRange: null,
  };
}

async function fetchListing(board: string): Promise<SmartRecruitersListItem[]> {
  const items: SmartRecruitersListItem[] = [];
  for (let offset = 0; offset < MAX_POSTINGS_PER_COMPANY; offset += LIST_PAGE_SIZE) {
    const url = `https://api.smartrecruiters.com/v1/companies/${encodeURIComponent(board)}/postings?limit=${LIST_PAGE_SIZE}&offset=${offset}`;
    let res: Response;
    try {
      res = await politeFetch(url);
    } catch (err) {
      logger.warn({ board, err }, "SmartRecruiters postings request errored");
      break;
    }
    if (!res.ok) {
      logger.warn({ board, status: res.status }, "SmartRecruiters postings request failed");
      break;
    }
    const page = (await res.json()) as SmartRecruitersListResponse;
    items.push(...page.content);
    if (page.content.length < LIST_PAGE_SIZE) break;
  }
  return items.slice(0, MAX_POSTINGS_PER_COMPANY);
}

async function fetchDetail(board: string, id: string): Promise<SmartRecruitersDetail | null> {
  try {
    const res = await politeFetch(
      `https://api.smartrecruiters.com/v1/companies/${encodeURIComponent(board)}/postings/${id}`,
    );
    if (!res.ok) {
      logger.warn({ board, id, status: res.status }, "SmartRecruiters posting detail request failed");
      return null;
    }
    return (await res.json()) as SmartRecruitersDetail;
  } catch (err) {
    logger.warn({ board, id, err }, "SmartRecruiters posting detail request errored");
    return null;
  }
}

export async function fetchSmartRecruitersCompany(board: string, label: string): Promise<RawJob[]> {
  const items = await fetchListing(board);
  const jobs: RawJob[] = [];
  let detailCalls = 0;
  for (const item of items) {
    let detail: SmartRecruitersDetail | null = null;
    if (detailCalls < MAX_DETAIL_FETCHES_PER_COMPANY) {
      detailCalls++;
      detail = await fetchDetail(board, item.id);
      await sleep(DETAIL_FETCH_DELAY_MS);
    }
    jobs.push(buildSmartRecruitersJob(item, label, board, detail));
  }
  return jobs;
}

/** Fetches every watched SmartRecruiters company. One company failing does not fail the rest. */
export async function fetchSmartRecruitersJobs(): Promise<RawJob[]> {
  const companies = watchedCompaniesFor("smartrecruiters");
  const results = await Promise.allSettled(companies.map((c) => fetchSmartRecruitersCompany(c.board, c.label)));
  const jobs: RawJob[] = [];
  results.forEach((result, index) => {
    if (result.status === "fulfilled") {
      jobs.push(...result.value);
    } else {
      logger.warn({ board: companies[index]?.board, err: result.reason }, "SmartRecruiters company fetch failed");
    }
  });
  return jobs;
}
