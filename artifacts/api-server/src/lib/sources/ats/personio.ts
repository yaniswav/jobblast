// Personio public XML job feed client (Company Watch, lot H2). No
// credentials needed - this is the same feed a company enables for its
// career page. Docs: https://developer.personio.de/v1.0/reference/get_xml
//
// Feed shape (root <workzag-jobs>, repeated <position>): id, office,
// department, name (the title), a <jobDescriptions> block of one-or-more
// named <jobDescription><value>...HTML...</value></jobDescription> sections
// (can be empty for a given posting), and createdAt. There is no direct
// per-posting URL in the feed; the public job page is
// `https://<company>.jobs.personio.<tld>/job/<id>`, verified live (200 OK).
//
// Verified live against two real, public accounts: Personio's own
// (`personio.jobs.personio.de`) and `4401.jobs.personio.de` (44.01) - see
// lot H2's report for exact counts. `board` encodes both the subdomain and
// the TLD ("de" or "com") as `"<company>.<tld>"`, since the config schema
// keeps one string field per watched company rather than growing a
// per-ATS shape.
//
// XML is parsed with cheerio in XML mode (already a dependency, used
// elsewhere for HTML parsing) rather than a hand-rolled regex, since the
// feed nests a repeated element cheerio already knows how to walk.

import * as cheerio from "cheerio";
import { logger } from "../../logger";
import { watchedCompaniesFor } from "../companies";
import { toPostedDate } from "./dates";
import { stripHtml } from "../html";
import { politeFetch } from "../http";
import { MAX_POSTINGS_PER_COMPANY } from "./limits";
import type { RawJob } from "../types";

export type PersonioPosition = {
  id: string;
  name: string;
  office: string;
  createdAt: string;
  /** Joined text of every <jobDescription><value> block, still HTML. */
  descriptionHtml: string;
};

/** Pure: XML text -> parsed positions. Exported for the fixture test. */
export function parsePersonioXml(xml: string): PersonioPosition[] {
  const $ = cheerio.load(xml, { xmlMode: true });
  const positions: PersonioPosition[] = [];
  $("position").each((_, el) => {
    const $pos = $(el);
    const id = $pos.find("id").first().text().trim();
    const name = $pos.find("name").first().text().trim();
    if (!id || !name) return;
    const office = $pos.find("office").first().text().trim();
    const createdAt = $pos.find("createdAt").first().text().trim();
    const descriptionParts: string[] = [];
    $pos.find("jobDescription").each((_i, descEl) => {
      const text = $(descEl).find("value").first().text().trim();
      if (text) descriptionParts.push(text);
    });
    positions.push({ id, name, office, createdAt, descriptionHtml: descriptionParts.join("\n\n") });
  });
  return positions;
}

/** `"<company>.<tld>"` -> the two parts the feed URL and job URL need. */
function splitBoard(board: string) {
  const dot = board.lastIndexOf(".");
  if (dot <= 0) return { company: board, tld: "de" };
  return { company: board.slice(0, dot), tld: board.slice(dot + 1) };
}

/** Pure: parsed positions -> RawJob[]. Exported for the fixture test. */
export function normalizePersonioPositions(
  positions: PersonioPosition[],
  companyLabel: string,
  board: string,
): RawJob[] {
  const { company, tld } = splitBoard(board);
  return positions.slice(0, MAX_POSTINGS_PER_COMPANY).map((position) => ({
    source: "ats:personio",
    title: position.name,
    company: companyLabel,
    location: position.office,
    url: `https://${company}.jobs.personio.${tld}/job/${position.id}`,
    description: position.descriptionHtml ? stripHtml(position.descriptionHtml) : "",
    postedDate: toPostedDate(position.createdAt),
    salaryRange: null,
  }));
}

export async function fetchPersonioCompany(board: string, label: string): Promise<RawJob[]> {
  const { company, tld } = splitBoard(board);
  const url = `https://${company}.jobs.personio.${tld}/xml`;
  let res: Response;
  try {
    res = await politeFetch(url);
  } catch (err) {
    logger.warn({ board, err }, "Personio XML feed request errored");
    return [];
  }
  if (!res.ok) {
    logger.warn({ board, status: res.status }, "Personio XML feed request failed");
    return [];
  }
  const xml = await res.text();
  const positions = parsePersonioXml(xml);
  return normalizePersonioPositions(positions, label, board);
}

/** Fetches every watched Personio company. One company failing does not fail the rest. */
export async function fetchPersonioJobs(): Promise<RawJob[]> {
  const companies = watchedCompaniesFor("personio");
  const results = await Promise.allSettled(companies.map((c) => fetchPersonioCompany(c.board, c.label)));
  const jobs: RawJob[] = [];
  results.forEach((result, index) => {
    if (result.status === "fulfilled") {
      jobs.push(...result.value);
    } else {
      logger.warn({ board: companies[index]?.board, err: result.reason }, "Personio company fetch failed");
    }
  });
  return jobs;
}
