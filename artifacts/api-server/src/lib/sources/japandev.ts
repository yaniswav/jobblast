// japan-dev.com job board client. No API - fetches the server-rendered
// https://japan-dev.com/jobs listing page and parses job cards with cheerio.
// Verified live on 2026-08-13: despite being a Vue app, the jobs list itself
// is present in the initial HTML response (SSR), so a plain fetch + cheerio
// parse works without executing JS.
//
// Markup shape (as of the verification date): each listing is a
// `li.job-item`. Title + job URL come from `a.job-item__title`
// (href like "/jobs/COMPANY-SLUG/JOB-SLUG"). There is no dedicated
// "company name" text class - the only reliable place the display name
// appears is the `alt` attribute on the company logo image
// (`.company-logo__inner[alt]`), confirmed by spot-checking several cards
// (e.g. alt="Mico" next to "Senior Fullstack Engineer (Tokyo)"). Location
// and salary come from `.job__tag-desc` spans; other badges (residents-only,
// remote, etc.) come from `.job-top-tag-list__job-top-tag`. No long
// description is available on the listing page - same short-description
// tradeoff as tokyodev.ts.
//
// Parsing is defensive: cards missing a title/link/company are skipped and
// counted rather than throwing.

import * as cheerio from "cheerio";
import { logger } from "../logger";
import { politeFetch } from "./http";
import type { RawJob } from "./types";

const JOBS_URL = "https://japan-dev.com/jobs";
const SITE_BASE_URL = "https://japan-dev.com";

export async function fetchJapanDevJobs(): Promise<RawJob[]> {
  let res: Response;
  try {
    res = await politeFetch(JOBS_URL);
  } catch (err) {
    logger.warn({ err }, "japan-dev jobs page request errored");
    return [];
  }

  if (!res.ok) {
    logger.warn({ status: res.status }, "japan-dev jobs page request failed");
    return [];
  }

  const html = await res.text();
  const $ = cheerio.load(html);

  const jobs: RawJob[] = [];
  let skipped = 0;

  $("li.job-item").each((_, itemEl) => {
    const $item = $(itemEl);
    const $link = $item.find("a.job-item__title").first();
    const title = $link.text().trim();
    const href = $link.attr("href");
    const company = $item.find(".company-logo__inner").first().attr("alt")?.trim();

    if (!title || !href || !company) {
      skipped++;
      return;
    }

    const tagTexts = $item
      .find(".job-top-tag-list__job-top-tag, .job__tag-desc")
      .map((_, el) => $(el).text().trim().replace(/\s+/g, " "))
      .get()
      .filter(Boolean);

    const location = $item.find(".job__tag-desc").first().text().trim().replace(/\s+/g, " ") || "Japan";
    const salaryTag = tagTexts.find((tag) => /[¥$€]/.test(tag) || /\d[km]/i.test(tag)) ?? null;

    jobs.push({
      source: "JapanDev",
      title,
      company,
      location,
      url: href.startsWith("http") ? href : `${SITE_BASE_URL}${href}`,
      description: tagTexts.length > 0 ? `Tags: ${tagTexts.join(", ")}` : "",
      postedDate: new Date().toISOString().slice(0, 10),
      salaryRange: salaryTag,
    });
  });

  logger.info({ count: jobs.length, skipped }, "japan-dev jobs parsed");
  return jobs;
}
