// 104 Job Bank (104人力銀行) - Taiwan's largest job board. Unofficial: this
// hits the same JSON endpoint the 104.com.tw search page's frontend calls,
// there is no public API/key.
//
// IMPORTANT - verified live on 2026-08-13 that this endpoint is currently
// behind Cloudflare bot protection: every request to
// `/jobs/search/list` (regardless of query params, User-Agent, or Referer)
// gets a 302 redirect to `/error/404/` with `cf-cache-status: DYNAMIC` and a
// `window.__CF$cv$params` JS challenge stub in the sibling HTML page - i.e.
// the request never reaches the real handler. Plain GETs to
// `/jobs/search/?keyword=...` also return a near-empty SPA shell (no SSR
// data) rather than a 200 with job data. Per the brief's explicit
// instruction ("If the endpoint returns non-JSON or 4xx, log a warning and
// return [] - never retry aggressively, never spoof beyond a normal UA, no
// proxies"), this client is written defensively: it makes one attempt per
// query, and on anything other than a 200 JSON response it logs a warning
// and contributes zero jobs rather than working around the block.
//
// Area codes (from the brief): 6001001000 = Taipei, 6001002000 = New Taipei,
// 6001016000 = Kaohsiung. Kaohsiung was described as already confirmed;
// Taipei/New Taipei could NOT be independently verified against live JSON
// because every request (any area code) hits the same Cloudflare block
// above - so all three are used as given, unverified beyond that they are
// the values documented in the task brief.

import { loadConfig } from "../config";
import { logger } from "../logger";
import { politeFetch, sleep } from "./http";
import type { RawJob } from "./types";

const SEARCH_URL = "https://www.104.com.tw/jobs/search/list";
const REFERER = "https://www.104.com.tw/jobs/search/";
const JOB_BASE_URL = "https://www.104.com.tw/job/";

// Keywords and area codes come from `sources.job104` in
// jobblast.config.json. Keep both lists short - see the etiquette note above.
function settings(): { queries: string[]; areaCodes: string[] } {
  const { queries, areaCodes } = loadConfig().sources.job104;
  return { queries, areaCodes };
}
const THROTTLE_MS = 1_000;

type Job104Item = {
  jobNo: string;
  jobName: string;
  custName: string;
  salaryDesc?: string;
  jobAddrNoDesc?: string;
  description?: string;
  appearDate?: string;
};

type Job104Response = {
  data?: { list?: Job104Item[]; totalPage?: number };
};

function toPostedDate(appearDate: string | undefined): string {
  // 104 returns appearDate as e.g. "0813" (MMDD, current year implied) or
  // omits it entirely depending on endpoint version - too unreliable to
  // parse confidently, so we fall back to "today" like the other sources do
  // when their date field is missing/unparseable.
  if (appearDate && /^\d{4}-\d{2}-\d{2}$/.test(appearDate)) return appearDate;
  return new Date().toISOString().slice(0, 10);
}

async function searchOnce(keyword: string, area: string): Promise<Job104Item[]> {
  const params = new URLSearchParams({
    ro: "0",
    kwop: "7",
    keyword,
    area,
    order: "15",
    asc: "0",
    page: "1",
    mode: "s",
    jobsource: "2018indexpoc",
  });
  const url = `${SEARCH_URL}?${params.toString()}`;

  let res: Response;
  try {
    res = await politeFetch(url, { headers: { Referer: REFERER, Accept: "application/json" } });
  } catch (err) {
    logger.warn({ keyword, area, err }, "104 search request errored");
    return [];
  }

  if (!res.ok) {
    logger.warn({ keyword, area, status: res.status }, "104 search request failed (non-2xx)");
    return [];
  }

  const contentType = res.headers.get("content-type") ?? "";
  if (!contentType.includes("application/json")) {
    logger.warn({ keyword, area, contentType }, "104 search returned non-JSON response, skipping");
    return [];
  }

  try {
    const data = (await res.json()) as Job104Response;
    return data.data?.list ?? [];
  } catch (err) {
    logger.warn({ keyword, area, err }, "104 search response was not valid JSON");
    return [];
  }
}

export async function fetch104Jobs(): Promise<RawJob[]> {
  const jobsByNo = new Map<string, Job104Item>();
  const { queries, areaCodes } = settings();

  // Sequential with a small throttle between calls, per the brief's
  // etiquette note (2-3 keywords x up to 3 areas = up to 9 calls, page 1
  // only, ~1s apart).
  for (const keyword of queries) {
    for (const area of areaCodes) {
      const items = await searchOnce(keyword, area);
      for (const item of items) jobsByNo.set(item.jobNo, item);
      await sleep(THROTTLE_MS);
    }
  }

  if (jobsByNo.size === 0) {
    logger.info("104: no jobs collected (endpoint likely blocked by Cloudflare - see job104.ts header comment)");
  }

  return Array.from(jobsByNo.values()).map((item) => ({
    source: "104",
    title: item.jobName,
    company: item.custName,
    location: item.jobAddrNoDesc ?? "",
    url: `${JOB_BASE_URL}${item.jobNo}`,
    description: item.description ?? "",
    postedDate: toPostedDate(item.appearDate),
    salaryRange: item.salaryDesc ?? null,
  }));
}
