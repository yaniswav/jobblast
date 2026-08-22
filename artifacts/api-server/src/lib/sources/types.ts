// Shared types for the job aggregation pipeline (lib/sources/*).
//
// Flow: source client (francetravail.ts / greenhouse.ts / lever.ts /
// adzuna.ts) -> RawJob[] -> scoring.ts -> ScoredJob -> refresh.ts normalizes
// + tailors -> job_listings insert rows.

export type JobSourceName =
  | "France Travail"
  | "Greenhouse"
  | "Lever"
  | "Adzuna"
  | "Yourator"
  | "104"
  | "TokyoDev"
  | "JapanDev"
  | "Himalayas"
  | "RemoteOK"
  | "Remotive"
  | "Arbeitnow"
  | "AI Scout"
  | "Notion Inbox";

/** A job listing as fetched from a source, before scoring/normalization. */
export type RawJob = {
  source: JobSourceName;
  title: string;
  company: string;
  /** Free-text location as reported by the source (may be empty). */
  location: string;
  url: string;
  description: string;
  /** ISO date string (YYYY-MM-DD). */
  postedDate: string;
  /** Human-readable salary range/comment, or null when the source has none. */
  salaryRange: string | null;
};

export type ScoredJob = RawJob & {
  relevanceScore: number;
  matchReasons: string[];
  highlightedSkills: string[];
};
