// Recruitee public careers-site API client (Company Watch, lot H2). No API
// key required - this is the same endpoint the company's own public careers
// page calls, distinct from Recruitee's authenticated ATS API.
// Docs: https://docs.recruitee.com/reference/offers-get
//
// Verified live against a real, public, currently-hiring account:
// `helloprint` (https://helloprint.recruitee.com) returned postings with a
// full HTML `description` and a structured `salary` block - see lot H2's
// report for the exact count on the day this was verified.

import { logger } from "../../logger";
import { watchedCompaniesFor } from "../companies";
import { toPostedDate } from "./dates";
import { stripHtml } from "../html";
import { politeFetch } from "../http";
import { MAX_POSTINGS_PER_COMPANY } from "./limits";
import type { RawJob } from "../types";

type RecruiteeSalary = {
  min?: string | number | null;
  max?: string | number | null;
  period?: string | null;
  currency?: string | null;
} | null;

type RecruiteeOffer = {
  title: string;
  description?: string | null;
  careers_url?: string;
  location?: string;
  city?: string;
  country?: string;
  salary?: RecruiteeSalary;
  published_at?: string;
  created_at?: string;
};

type RecruiteeOffersResponse = {
  offers: RecruiteeOffer[];
};

function formatSalary(salary: RecruiteeSalary | undefined): string | null {
  if (!salary) return null;
  const bounds = [salary.min, salary.max].filter((v) => v !== null && v !== undefined && v !== "");
  if (bounds.length === 0) return null;
  const range = bounds.join(" - ");
  return [salary.currency, range, salary.period ? `/ ${salary.period}` : null].filter(Boolean).join(" ").trim();
}

/** Pure: JSON -> RawJob[]. Exported for the fixture test. */
export function normalizeRecruiteeJobs(data: RecruiteeOffersResponse, companyLabel: string): RawJob[] {
  return data.offers.slice(0, MAX_POSTINGS_PER_COMPANY).map((offer) => ({
    source: "ats:recruitee",
    title: offer.title,
    company: companyLabel,
    location: offer.location || [offer.city, offer.country].filter(Boolean).join(", "),
    url: offer.careers_url ?? "",
    description: offer.description ? stripHtml(offer.description) : "",
    postedDate: toPostedDate(offer.published_at ?? offer.created_at),
    salaryRange: formatSalary(offer.salary),
  }));
}

export async function fetchRecruiteeCompany(board: string, label: string): Promise<RawJob[]> {
  const url = `https://${board}.recruitee.com/api/offers/`;
  let res: Response;
  try {
    res = await politeFetch(url);
  } catch (err) {
    logger.warn({ board, err }, "Recruitee offers request errored");
    return [];
  }
  if (!res.ok) {
    logger.warn({ board, status: res.status }, "Recruitee offers request failed");
    return [];
  }
  const data = (await res.json()) as RecruiteeOffersResponse;
  return normalizeRecruiteeJobs(data, label);
}

/** Fetches every watched Recruitee company. One company failing does not fail the rest. */
export async function fetchRecruiteeJobs(): Promise<RawJob[]> {
  const companies = watchedCompaniesFor("recruitee");
  const results = await Promise.allSettled(companies.map((c) => fetchRecruiteeCompany(c.board, c.label)));
  const jobs: RawJob[] = [];
  results.forEach((result, index) => {
    if (result.status === "fulfilled") {
      jobs.push(...result.value);
    } else {
      logger.warn({ board: companies[index]?.board, err: result.reason }, "Recruitee company fetch failed");
    }
  });
  return jobs;
}
