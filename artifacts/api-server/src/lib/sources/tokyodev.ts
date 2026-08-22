// TokyoDev job board client. No API - this fetches the server-rendered
// https://www.tokyodev.com/jobs listing page and parses job cards with
// cheerio. Verified live on 2026-08-13: the page is plain server-rendered
// HTML (Rails/Turbo, no client-side data fetch needed to see listings).
//
// Markup shape (as of the verification date): companies are grouped in
// `<li id="company_SLUG">` blocks; each open role inside a company is a
// `[data-collapsable-list-target="item"]` div containing a title link
// (`a.font-bold`, href like "/companies/SLUG/jobs/JOB-SLUG") and a row of
// `a.tag` links (salary range, remote/residents-only status, tech tags like
// "c-plus-plus"/"embedded"/"python"). There is no long-form description on
// the listing page itself (that lives on the per-job page, which we don't
// fetch to keep request volume low) - so the RawJob description is built
// from the tag text, which is short but sufficient for scoring.ts.
//
// Parsing is defensive: any card missing a title/link is skipped rather
// than throwing, and the final skipped count is logged so a markup change
// on TokyoDev's end is visible in logs instead of silently returning zero
// jobs forever.

import * as cheerio from "cheerio";
import { logger } from "../logger";
import { politeFetch } from "./http";
import type { RawJob } from "./types";

const JOBS_URL = "https://www.tokyodev.com/jobs";
const SITE_BASE_URL = "https://www.tokyodev.com";

export async function fetchTokyoDevJobs(): Promise<RawJob[]> {
  let res: Response;
  try {
    res = await politeFetch(JOBS_URL);
  } catch (err) {
    logger.warn({ err }, "TokyoDev jobs page request errored");
    return [];
  }

  if (!res.ok) {
    logger.warn({ status: res.status }, "TokyoDev jobs page request failed");
    return [];
  }

  const html = await res.text();
  const $ = cheerio.load(html);

  const jobs: RawJob[] = [];
  let skipped = 0;

  $('li[id^="company_"]').each((_, companyEl) => {
    const $company = $(companyEl);
    const companyName = $company.find("h3 a").first().text().trim();

    $company.find('[data-collapsable-list-target="item"]').each((_, itemEl) => {
      const $item = $(itemEl);
      const $link = $item.find("a.font-bold").first();
      const title = $link.text().trim();
      const href = $link.attr("href");

      if (!title || !href || !companyName) {
        skipped++;
        return;
      }

      const tags = $item
        .find("a.tag")
        .map((_, tagEl) => $(tagEl).text().trim())
        .get()
        .filter(Boolean);

      const salaryTag = tags.find((tag) => /[¥$€]/.test(tag) || /\d[km]/i.test(tag)) ?? null;

      jobs.push({
        source: "TokyoDev",
        title,
        company: companyName,
        location: tags.some((tag) => /remote/i.test(tag)) ? "Remote / Japan" : "Japan",
        url: href.startsWith("http") ? href : `${SITE_BASE_URL}${href}`,
        description: tags.length > 0 ? `Tags: ${tags.join(", ")}` : "",
        postedDate: new Date().toISOString().slice(0, 10),
        salaryRange: salaryTag,
      });
    });
  });

  logger.info({ count: jobs.length, skipped }, "TokyoDev jobs parsed");
  return jobs;
}
