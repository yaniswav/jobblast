// Shared politeness limits for the Company Watch adapters (lot H2). One
// place so "how much do we ask one company for" is a single, documented
// number instead of six copies that can drift.

/** Hard cap on postings kept per watched company, across every ATS. */
export const MAX_POSTINGS_PER_COMPANY = 200;

/**
 * SmartRecruiters and Workday do not return a full description in their
 * listing call - only a per-posting detail call has it (verified against
 * real accounts, see the lot H2 report). Fetching detail for all 200
 * postings every cycle would mean 200 extra requests per company; this caps
 * how many of them get the extra call, in listing order. Postings beyond the
 * cap still land in the pool, just with a shorter, list-derived description.
 */
export const MAX_DETAIL_FETCHES_PER_COMPANY = 50;

/** Delay between sequential per-posting detail calls to the same company. */
export const DETAIL_FETCH_DELAY_MS = 120;

/**
 * Keyword-targeted listing (lot J3, see workday.ts / smartrecruiters.ts /
 * keyword-search.ts): Workday's own search endpoint (`searchText`) and
 * SmartRecruiters' public API (`?q=`, verified live against Grab) both let a
 * watched company be searched with the same free-text a follower's own
 * keyword list already carries, instead of only ever reading the first page
 * in whatever order the ATS defaults to. Capped for the same reason as the
 * two constants above: a follower's keyword list otherwise turns one watched
 * company into that many extra listing requests every refresh cycle.
 */
export const MAX_KEYWORDS_PER_COMPANY = 5;

/**
 * Pages fetched per follower keyword. Workday's page is small (PAGE_SIZE=20
 * in workday.ts) so a keyword worth searching gets several; SmartRecruiters'
 * listing page is 100 already (LIST_PAGE_SIZE in smartrecruiters.ts), so one
 * page per keyword is plenty without multiplying the request count on top of
 * an already-large page.
 */
export const MAX_TARGETED_PAGES_PER_KEYWORD_WORKDAY = 3;
export const MAX_TARGETED_PAGES_PER_KEYWORD_SMARTRECRUITERS = 1;
