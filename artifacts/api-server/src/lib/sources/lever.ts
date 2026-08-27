// Lever public Postings API client. No API key required.
// Docs: https://github.com/lever/postings-api

import { logger } from "../logger";
import { leverBoards } from "./companies";
import type { RawJob } from "./types";

type LeverPosting = {
  id: string;
  text: string;
  hostedUrl: string;
  categories?: { location?: string; commitment?: string; team?: string };
  descriptionPlain?: string;
  createdAt?: number;
};

function toPostedDate(createdAt: number | undefined): string {
  const date = createdAt ? new Date(createdAt) : new Date();
  if (Number.isNaN(date.getTime())) return new Date().toISOString().slice(0, 10);
  return date.toISOString().slice(0, 10);
}

/**
 * Fetches one Lever board. Exported (lot H5) so instance-watch seeding
 * (lib/sources/refresh.ts's fetchInstanceWatchesIntoPool) can fetch a single
 * catalog company - see fetchGreenhouseBoard's comment in greenhouse.ts.
 */
export async function fetchLeverBoard(board: { slug: string; name: string }): Promise<RawJob[]> {
  const url = `https://api.lever.co/v0/postings/${board.slug}?mode=json`;
  const res = await fetch(url);
  if (!res.ok) {
    logger.warn({ board: board.slug, status: res.status }, "Lever board request failed");
    return [];
  }
  const postings = (await res.json()) as LeverPosting[];
  return postings.map((posting) => ({
    source: "Lever",
    title: posting.text,
    company: board.name,
    location: posting.categories?.location ?? "",
    url: posting.hostedUrl,
    description: posting.descriptionPlain ?? "",
    postedDate: toPostedDate(posting.createdAt),
    salaryRange: null,
  }));
}

/** Fetches all configured Lever boards. A single board failing does not fail the rest. */
export async function fetchLeverJobs(): Promise<RawJob[]> {
  const boards = leverBoards();
  const results = await Promise.allSettled(boards.map((board) => fetchLeverBoard(board)));
  const jobs: RawJob[] = [];
  results.forEach((result, index) => {
    if (result.status === "fulfilled") {
      jobs.push(...result.value);
    } else {
      logger.warn({ board: boards[index]?.slug, err: result.reason }, "Lever board fetch failed");
    }
  });
  return jobs;
}
