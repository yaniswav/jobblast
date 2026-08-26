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
