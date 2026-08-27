// What "fetched once platform-wide" actually means, as a pure function.
//
// Sources are not uniformly shareable (docs/SAAS-ARCHITECTURE.md section
// 3.2). RemoteOK-style feeds return the same bytes for everyone; France
// Travail, Adzuna and 104 take the account's own keywords and areas. So the
// unit of work for a refresh is not a user, it is a **query signature**:
// `source + canonicalized parameters`. Two accounts hunting "C++ in Paris"
// share one fetch; two accounts hunting different things do not.
//
// This is step E3's stated risk, and its stated mitigation: canonicalization
// is a pure function with a table-driven test, because getting it wrong is
// silent in both directions. Over-share (two different queries collapsing
// into one signature) and an account sees postings it never asked for.
// Under-share (the same query producing two signatures) and every account
// gets its own fetch, which blows the polite request budget the README
// promises.
//
// Parameters that only change how results are *scored* or *filtered locally*
// are deliberately NOT part of a signature: they do not change what is
// fetched, and folding them in would fragment signatures for nothing.

import { createHash } from "node:crypto";
import type { JobBlastConfig } from "../config";
import { mergeCompanyBoards } from "./companies";

/**
 * Source ids. Most match a `sources.*` key in the config; the six Company
 * Watch ATSs beyond Greenhouse/Lever (lot H2) have no `sources.*` entry of
 * their own - "enabled" for them just means "this account watches at least
 * one company on that ATS" (see sourceQueries() below).
 */
export const SOURCE_IDS = [
  "franceTravail",
  "greenhouse",
  "lever",
  "adzuna",
  "jooble",
  "careerjet",
  "yourator",
  "job104",
  "tokyodev",
  "japandev",
  "himalayas",
  "remoteok",
  "remotive",
  "arbeitnow",
  "notionInbox",
  "aiScout",
  "smartrecruiters",
  "ashby",
  "workable",
  "recruitee",
  "personio",
  "workday",
] as const;
export type SourceId = (typeof SOURCE_IDS)[number];

/**
 * Sources that reach an account's own private workspace or spend an account's
 * own agent budget. They are never shared between accounts, whatever their
 * parameters say, and in `saas` they do not run at all (section 10).
 */
export const PRIVATE_SOURCES: ReadonlySet<SourceId> = new Set<SourceId>([
  "notionInbox",
  "aiScout",
]);

export type SourceQuery = {
  source: SourceId;
  /** Everything that changes what comes back over the wire. */
  params: Record<string, unknown>;
  /** sha256(source + canonical params), truncated: this is a cache key, not a MAC. */
  signature: string;
};

/**
 * Stable JSON: object keys sorted, arrays sorted and de-duplicated, strings
 * trimmed and lowercased.
 *
 * Arrays are sorted because `["c++", "linux"]` and `["linux", "c++"]` fetch
 * the same postings in a different order, and two accounts writing their
 * keyword list in a different order must not each pay for a fetch. Case and
 * surrounding whitespace are normalized for the same reason.
 */
export function canonicalize(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (typeof value === "string") return JSON.stringify(value.trim().toLowerCase());
  if (typeof value === "number" || typeof value === "boolean") return JSON.stringify(value);
  if (Array.isArray(value)) {
    const items = Array.from(new Set(value.map((item) => canonicalize(item)))).sort();
    return `[${items.join(",")}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .map(([key, v]) => [key, canonicalize(v)] as const)
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return `{${entries.map(([key, v]) => `${JSON.stringify(key)}:${v}`).join(",")}}`;
}

/** The signature of one source's parameters. Same inputs, same string, always. */
export function signatureOf(source: string, params: Record<string, unknown>): string {
  return createHash("sha256").update(`${source}|${canonicalize(params)}`).digest("hex").slice(0, 32);
}

/** The six Company Watch ATSs beyond Greenhouse/Lever - see sourceQueries() below. */
const COMPANY_WATCH_ATS_IDS = ["smartrecruiters", "ashby", "workable", "recruitee", "personio", "workday"] as const;

/**
 * The two Company Watch ATSs whose fetcher actually searches with the
 * account's keywords (lot J3, lib/sources/ats/keyword-search.ts): Workday's
 * `searchText` and SmartRecruiters' `?q=`, both verified live. The other
 * four still only take a board list, so folding keywords into their params
 * too would fragment their signatures (more fetches) for a parameter no
 * request they make ever uses - see this file's header on why `params` is
 * "what the fetcher actually puts in the URL".
 */
const KEYWORD_TARGETED_ATS_IDS: ReadonlySet<(typeof COMPANY_WATCH_ATS_IDS)[number]> = new Set([
  "workday",
  "smartrecruiters",
]);

function companyWatchQueries(config: JobBlastConfig): Array<{
  source: SourceId;
  enabled: boolean;
  params: Record<string, unknown>;
}> {
  return COMPANY_WATCH_ATS_IDS.map((ats) => {
    const boards = config.watchedCompanies.filter((c) => c.ats === ats).map((c) => c.board);
    // Two accounts watching the exact same boards but hunting different
    // keywords no longer share this fetch (lot J3): each targeted search is
    // run under one ambient account's context (lib/queue/handlers.ts's
    // runRefresh), so every subscriber sharing a signature must be asking
    // with the identical keyword list for that to be correct - the same
    // "accepted, and no worse than today's board-list split" tradeoff
    // mergeCompanyBoards's own doc comment already makes.
    const params = KEYWORD_TARGETED_ATS_IDS.has(ats)
      ? { boards, keywords: config.sources.franceTravail.keywords }
      : { boards };
    return { source: ats, enabled: boards.length > 0, params };
  });
}

/**
 * The fetch-affecting parameters of every source this config has enabled.
 *
 * The `params` object per source is the contract: adding a key fragments
 * signatures (more fetches, still correct), removing one merges them (fewer
 * fetches, and wrong if it really did change the request). Keep it to what
 * the fetcher actually puts in the URL.
 */
export function sourceQueries(config: JobBlastConfig): SourceQuery[] {
  const { sources } = config;
  const queries: Array<{ source: SourceId; enabled: boolean; params: Record<string, unknown> }> = [
    {
      source: "franceTravail",
      enabled: sources.franceTravail.enabled,
      params: {
        keywords: sources.franceTravail.keywords,
        departements: sources.franceTravail.departements,
        contractTypes: sources.franceTravail.contractTypes,
        experienceLevel: sources.franceTravail.experienceLevel,
      },
    },
    {
      source: "greenhouse",
      // Also enabled by a watched company on Greenhouse, even when the
      // hand-curated board list itself is switched off (lot H2).
      enabled: sources.greenhouse.enabled || config.watchedCompanies.some((c) => c.ats === "greenhouse"),
      // Only the board slugs reach the network; `name` is a display label.
      // Includes watched companies - two accounts sharing the exact same
      // hand-curated list plus watchlist still share one fetch.
      params: {
        boards: mergeCompanyBoards(sources.greenhouse.boards, "greenhouse", config.watchedCompanies).map(
          (board) => board.slug,
        ),
      },
    },
    {
      source: "lever",
      enabled: sources.lever.enabled || config.watchedCompanies.some((c) => c.ats === "lever"),
      params: {
        boards: mergeCompanyBoards(sources.lever.boards, "lever", config.watchedCompanies).map((board) => board.slug),
      },
    },
    {
      source: "adzuna",
      enabled: sources.adzuna.enabled,
      params: {
        country: sources.adzuna.country,
        queries: sources.adzuna.queries,
        where: sources.adzuna.where,
        resultsPerPage: sources.adzuna.resultsPerPage,
      },
    },
    {
      source: "jooble",
      enabled: sources.jooble.enabled,
      params: {
        queries: sources.jooble.queries,
        location: sources.jooble.location,
        resultsPerPage: sources.jooble.resultsPerPage,
      },
    },
    {
      source: "careerjet",
      enabled: sources.careerjet.enabled,
      params: {
        queries: sources.careerjet.queries,
        location: sources.careerjet.location,
        pageSize: sources.careerjet.pageSize,
      },
    },
    {
      source: "yourator",
      enabled: sources.yourator.enabled,
      // relevanceFilter is a client-side pre-filter, not part of the request.
      params: { pages: sources.yourator.pages },
    },
    {
      source: "job104",
      enabled: sources.job104.enabled,
      params: { queries: sources.job104.queries, areaCodes: sources.job104.areaCodes },
    },
    { source: "tokyodev", enabled: sources.tokyodev.enabled, params: {} },
    { source: "japandev", enabled: sources.japandev.enabled, params: {} },
    {
      source: "himalayas",
      enabled: sources.himalayas.enabled,
      params: { queries: sources.himalayas.queries, limit: sources.himalayas.limit },
    },
    { source: "remoteok", enabled: sources.remoteok.enabled, params: { tags: sources.remoteok.tags } },
    {
      source: "remotive",
      enabled: sources.remotive.enabled,
      params: {
        category: sources.remotive.category,
        search: sources.remotive.search,
        limit: sources.remotive.limit,
      },
    },
    { source: "arbeitnow", enabled: sources.arbeitnow.enabled, params: {} },
    {
      source: "notionInbox",
      enabled: sources.notionInbox.enabled,
      params: { pageUrl: sources.notionInbox.pageUrl, dataSourceUrl: sources.notionInbox.dataSourceUrl },
    },
    {
      source: "aiScout",
      enabled: sources.aiScout.enabled,
      params: {
        allowedConnectors: sources.aiScout.allowedConnectors,
        targetCompanies: sources.aiScout.targetCompanies,
        targetSites: sources.aiScout.targetSites,
        maxPostings: sources.aiScout.maxPostings,
        effortLevel: sources.aiScout.effortLevel,
      },
    },
    // The six Company Watch ATSs beyond Greenhouse/Lever (lot H2): no
    // `sources.*` boolean of their own, "enabled" is simply "this account
    // watches at least one company on that ATS". Params are that ATS's
    // watched board ids, so two accounts watching the exact same set of
    // companies on one ATS share a fetch, same tradeoff as Greenhouse/Lever's
    // hand-curated lists above (an account watching a different combination
    // still gets its own fetch, rather than fetching per company).
    ...companyWatchQueries(config),
  ];

  return queries
    .filter((entry) => entry.enabled)
    .map((entry) => ({
      source: entry.source,
      params: entry.params,
      signature: signatureOf(entry.source, entry.params),
    }));
}

export type SignatureGroup = {
  source: SourceId;
  signature: string;
  /** Every account that asked for exactly this. Never empty. */
  subscribers: string[];
};

/**
 * Groups accounts by what they are actually asking each source for. The
 * result is the refresh cycle's work list: one entry is one fetch, however
 * many accounts are waiting for it.
 *
 * `subscribers` keeps the input order, so the first one is a stable choice of
 * "whose configuration do we run the fetch under" - they are all identical
 * for the parameters that matter, which is exactly what the signature says.
 */
export function groupBySignature(
  perUser: ReadonlyArray<{ userId: string; queries: readonly SourceQuery[] }>,
): SignatureGroup[] {
  const groups = new Map<string, SignatureGroup>();
  for (const { userId, queries } of perUser) {
    for (const query of queries) {
      // A private source belongs to one account: give it a signature nobody
      // else can share, rather than letting two accounts pointed at two
      // different Notion pages collide on an empty-parameter default.
      const key = PRIVATE_SOURCES.has(query.source)
        ? `${query.signature}:${userId}`
        : query.signature;
      const existing = groups.get(key);
      if (existing) {
        if (!existing.subscribers.includes(userId)) existing.subscribers.push(userId);
      } else {
        groups.set(key, { source: query.source, signature: key, subscribers: [userId] });
      }
    }
  }
  return Array.from(groups.values());
}
