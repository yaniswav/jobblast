// Greenhouse public Job Board API client. No API key required.
// Docs: https://developers.greenhouse.io/job-board.html

import { logger } from "../logger";
import { stripHtml } from "./html";
import { greenhouseBoards } from "./companies";
import type { RawJob } from "./types";

type GreenhouseJob = {
  id: number;
  title: string;
  absolute_url: string;
  location?: { name?: string };
  content?: string;
  updated_at?: string;
};

type GreenhouseBoardResponse = {
  jobs: GreenhouseJob[];
};

function toPostedDate(updatedAt: string | undefined): string {
  const date = updatedAt ? new Date(updatedAt) : new Date();
  if (Number.isNaN(date.getTime())) return new Date().toISOString().slice(0, 10);
  return date.toISOString().slice(0, 10);
}

/**
 * Fetches one Greenhouse board. Exported (lot H5) so instance-watch seeding
 * (lib/sources/refresh.ts's fetchInstanceWatchesIntoPool) can fetch a single
 * catalog company without going through greenhouseBoards()'s account-config
 * merge - the two other per-company adapters (workday.ts, etc.) already
 * exposed this shape for lot H2.
 */
export async function fetchGreenhouseBoard(board: { slug: string; name: string }): Promise<RawJob[]> {
  const url = `https://boards-api.greenhouse.io/v1/boards/${board.slug}/jobs?content=true`;
  const res = await fetch(url);
  if (!res.ok) {
    logger.warn({ board: board.slug, status: res.status }, "Greenhouse board request failed");
    return [];
  }
  const data = (await res.json()) as GreenhouseBoardResponse;
  return data.jobs.map((job) => ({
    source: "Greenhouse",
    title: job.title,
    company: board.name,
    location: job.location?.name ?? "",
    url: job.absolute_url,
    description: job.content ? stripHtml(job.content) : "",
    postedDate: toPostedDate(job.updated_at),
    salaryRange: null,
  }));
}

/** Fetches all configured Greenhouse boards. A single board failing does not fail the rest. */
export async function fetchGreenhouseJobs(): Promise<RawJob[]> {
  const boards = greenhouseBoards();
  const results = await Promise.allSettled(boards.map((board) => fetchGreenhouseBoard(board)));
  const jobs: RawJob[] = [];
  results.forEach((result, index) => {
    if (result.status === "fulfilled") {
      jobs.push(...result.value);
    } else {
      logger.warn(
        { board: boards[index]?.slug, err: result.reason },
        "Greenhouse board fetch failed",
      );
    }
  });
  return jobs;
}
