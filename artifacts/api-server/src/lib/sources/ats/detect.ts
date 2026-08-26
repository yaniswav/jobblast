// Company Watch, step 1: from a pasted career-page URL, identify which ATS
// serves it and the board/account identifier its public JSON (or XML)
// endpoint needs. Pure logic, no network - lot H2's brief.
//
// Verified against a real, public, currently-hiring account on each ATS
// before writing its parser (see the six lib/sources/ats/*.ts files and the
// lot H2 report for exactly which company and how many postings). Patterns
// below match what those real URLs looked like, not just the docs.
//
//   Greenhouse       boards.greenhouse.io/<board> or job-boards.greenhouse.io/<board>
//   Lever            jobs.lever.co/<company>
//   SmartRecruiters  careers.smartrecruiters.com/<Company> or jobs.smartrecruiters.com/<Company>
//   Ashby            jobs.ashbyhq.com/<board>
//   Workable         apply.workable.com/<account>            (not /j/<code>, a single-job permalink)
//   Recruitee        <company>.recruitee.com
//   Personio         <company>.jobs.personio.de or .com
//   Workday          <tenant>.wd<n>.myworkdayjobs.com/[<locale>/]<site>

import type { AtsId } from "../../config";

export type AtsDetectionResult =
  | { supported: true; ats: AtsId; board: string; label: string }
  | { supported: false; reason: string };

/** Display name per ATS, for the API response and the Settings UI badge. */
export const ATS_LABELS = {
  greenhouse: "Greenhouse",
  lever: "Lever",
  smartrecruiters: "SmartRecruiters",
  ashby: "Ashby",
  workable: "Workable",
  recruitee: "Recruitee",
  personio: "Personio",
  workday: "Workday",
} satisfies Record<AtsId, string>;

/** Turns a slug/subdomain into a readable default label ("acme-robotics" -> "Acme Robotics"). */
function humanize(slug: string): string {
  const words = slug.replace(/[-_.]+/g, " ").trim();
  if (!words) return slug;
  return words.replace(/\b\w/g, (c) => c.toUpperCase());
}

function unsupported(rawUrl: string): AtsDetectionResult {
  return {
    supported: false,
    reason:
      `No supported ATS pattern matched "${rawUrl}". Supported: Greenhouse, Lever, ` +
      "SmartRecruiters, Ashby, Workable, Recruitee, Personio, Workday.",
  };
}

// A locale segment Workday sometimes puts before the site name in its public
// URL (en-US, fr-FR, de, ...). Segments matching this are skipped when
// looking for the actual site name.
const LOCALE_SEGMENT = /^[a-z]{2}(-[A-Z]{2})?$/;

function detectWorkday(host: string, segments: string[], rawUrl: string): AtsDetectionResult {
  const match = /^([a-z0-9-]+)\.(wd\d+)\.myworkdayjobs\.com$/.exec(host);
  if (!match) return unsupported(rawUrl);
  const [, tenant, wdNumber] = match;
  const site = segments.find((segment) => !LOCALE_SEGMENT.test(segment) && segment !== "job");
  if (!tenant || !wdNumber || !site) {
    return {
      supported: false,
      reason:
        "Recognized a Workday domain but could not find the career site name in the URL. " +
        "Paste the full career page URL, e.g. https://tenant.wd3.myworkdayjobs.com/en-US/Careers.",
    };
  }
  return { supported: true, ats: "workday", board: `${tenant}/${wdNumber}/${site}`, label: humanize(tenant) };
}

function detectPersonio(host: string, rawUrl: string): AtsDetectionResult {
  const match = /^([a-z0-9-]+)\.jobs\.personio\.(de|com)$/.exec(host);
  if (!match) return unsupported(rawUrl);
  const [, company, tld] = match;
  if (!company || !tld) return unsupported(rawUrl);
  return { supported: true, ats: "personio", board: `${company}.${tld}`, label: humanize(company) };
}

/** Identifies the ATS and board for a pasted career-page URL, or explains why it can't. */
export function detectAts(rawUrl: string): AtsDetectionResult {
  const trimmed = rawUrl.trim();
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return { supported: false, reason: `"${trimmed}" is not a valid URL.` };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { supported: false, reason: `"${trimmed}" must be an http(s) URL.` };
  }

  const host = url.hostname.toLowerCase();
  const segments = url.pathname.split("/").filter(Boolean);

  if (host === "boards.greenhouse.io" || host === "job-boards.greenhouse.io") {
    const board = segments[0];
    if (!board) return unsupported(trimmed);
    return { supported: true, ats: "greenhouse", board, label: humanize(board) };
  }

  if (host === "jobs.lever.co") {
    const board = segments[0];
    if (!board) return unsupported(trimmed);
    return { supported: true, ats: "lever", board, label: humanize(board) };
  }

  if (host === "jobs.ashbyhq.com") {
    const board = segments[0];
    if (!board) return unsupported(trimmed);
    return { supported: true, ats: "ashby", board, label: humanize(board) };
  }

  if (host === "apply.workable.com") {
    const account = segments[0];
    if (!account || account === "j") {
      return {
        supported: false,
        reason:
          "Paste the company's Workable careers page URL (e.g. https://apply.workable.com/<company>), " +
          "not a single job link.",
      };
    }
    return { supported: true, ats: "workable", board: account, label: humanize(account) };
  }

  if (host.endsWith(".recruitee.com")) {
    const company = host.slice(0, -".recruitee.com".length);
    if (!company) return unsupported(trimmed);
    return { supported: true, ats: "recruitee", board: company, label: humanize(company) };
  }

  if (host === "careers.smartrecruiters.com" || host === "jobs.smartrecruiters.com") {
    const company = segments[0];
    if (!company) return unsupported(trimmed);
    return { supported: true, ats: "smartrecruiters", board: company, label: humanize(company) };
  }

  if (host.endsWith(".jobs.personio.de") || host.endsWith(".jobs.personio.com")) {
    return detectPersonio(host, trimmed);
  }

  if (host.endsWith(".myworkdayjobs.com")) {
    return detectWorkday(host, segments, trimmed);
  }

  return unsupported(trimmed);
}
