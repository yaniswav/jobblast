// Pure normalize() functions for the remaining Company Watch adapters
// (Ashby, Workable, Recruitee, SmartRecruiters, Workday), each fixture
// trimmed from a real response captured while verifying that adapter
// against a real, public, currently-hiring account (see the lot H2 report
// for exactly which company). Personio's own XML parsing gets its own file
// (personio.test.ts) since it is the one non-JSON format.

import { describe, expect, it } from "vitest";
import { normalizeAshbyJobs } from "./ashby";
import { normalizeRecruiteeJobs } from "./recruitee";
import { buildSmartRecruitersJob, descriptionFromDetail } from "./smartrecruiters";
import { normalizeWorkableJobs } from "./workable";
import { buildWorkdayJob, parseWorkdayBoard } from "./workday";

describe("normalizeAshbyJobs", () => {
  it("maps a job board response, including a compensation summary when offered", () => {
    const jobs = normalizeAshbyJobs(
      {
        jobs: [
          {
            id: "34413f8d",
            title: "Security Engineer, Cloud",
            location: "New York, NY (HQ)",
            jobUrl: "https://jobs.ashbyhq.com/ramp/34413f8d",
            descriptionPlain: "We are building the smart infrastructure for finance teams.",
            publishedAt: "2026-04-07T17:12:35.753+00:00",
            compensation: { compensationTierSummary: "$211.4K - $290.6K - Offers Equity" },
          },
        ],
      },
      "Ramp",
    );

    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({
      source: "ats:ashby",
      title: "Security Engineer, Cloud",
      company: "Ramp",
      location: "New York, NY (HQ)",
      url: "https://jobs.ashbyhq.com/ramp/34413f8d",
      description: "We are building the smart infrastructure for finance teams.",
      postedDate: "2026-04-07",
      salaryRange: "$211.4K - $290.6K - Offers Equity",
    });
  });

  it("falls back to a null salary when no compensation is disclosed", () => {
    const jobs = normalizeAshbyJobs(
      { jobs: [{ id: "1", title: "Role", location: "Remote", jobUrl: "https://jobs.ashbyhq.com/acme/1" }] },
      "Acme",
    );
    expect(jobs[0]?.salaryRange).toBeNull();
  });
});

describe("normalizeWorkableJobs", () => {
  it("maps the widget response and strips HTML from the description", () => {
    const jobs = normalizeWorkableJobs(
      {
        name: "Usercentrics",
        jobs: [
          {
            title: "Account Executive - MCP Manager",
            shortlink: "https://apply.workable.com/j/5793CA0928",
            city: "New York",
            state: "New York",
            country: "United States",
            published_on: "2026-05-14",
            description: "<h3>Account Executive</h3><p>Shape the future of AI governance.</p>",
          },
        ],
      },
      "Usercentrics",
    );

    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({
      source: "ats:workable",
      title: "Account Executive - MCP Manager",
      company: "Usercentrics",
      location: "New York, New York, United States",
      url: "https://apply.workable.com/j/5793CA0928",
      postedDate: "2026-05-14",
      salaryRange: null,
    });
    expect(jobs[0]?.description).toContain("Account Executive");
    expect(jobs[0]?.description).not.toContain("<h3>");
  });
});

describe("normalizeRecruiteeJobs", () => {
  it("maps offers, formatting a structured salary and stripping HTML", () => {
    const jobs = normalizeRecruiteeJobs(
      {
        offers: [
          {
            title: "Senior Test Automation Engineer",
            description: "<p>Helloprint is on a mission to become the world's leading infrastructure.</p>",
            careers_url: "https://helloprint.recruitee.com/o/senior-test-automation-engineer",
            city: "Rotterdam",
            country: "Netherlands",
            salary: { min: "4500", max: "6000", period: "month", currency: "EUR" },
            published_at: "2026-08-24 14:53:24 UTC",
          },
        ],
      },
      "Helloprint",
    );

    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({
      source: "ats:recruitee",
      title: "Senior Test Automation Engineer",
      company: "Helloprint",
      location: "Rotterdam, Netherlands",
      url: "https://helloprint.recruitee.com/o/senior-test-automation-engineer",
      salaryRange: "EUR 4500 - 6000 / month",
    });
    expect(jobs[0]?.description).toContain("Helloprint");
    expect(jobs[0]?.description).not.toContain("<p>");
  });

  it("returns a null salary when the offer has none", () => {
    const jobs = normalizeRecruiteeJobs(
      { offers: [{ title: "Role", careers_url: "https://acme.recruitee.com/o/role" }] },
      "Acme",
    );
    expect(jobs[0]?.salaryRange).toBeNull();
  });
});

describe("SmartRecruiters", () => {
  it("descriptionFromDetail joins every jobAd section and strips HTML", () => {
    const description = descriptionFromDetail({
      jobAd: {
        sections: {
          companyDescription: { text: "<p>Grab is Southeast Asia's leading superapp.</p>" },
          jobDescription: { text: "<p>Build scalable systems.</p>" },
        },
      },
    });
    expect(description).toContain("Southeast Asia");
    expect(description).toContain("Build scalable systems");
    expect(description).not.toContain("<p>");
  });

  it("descriptionFromDetail is empty when there is no jobAd", () => {
    expect(descriptionFromDetail({})).toBe("");
  });

  it("buildSmartRecruitersJob prefers the detail's postingUrl and falls back without detail", () => {
    const item = {
      id: "744000145701349",
      name: "Senior Software Engineer, Fullstack",
      location: { city: "HCMC", country: "vn", fullLocation: "HCMC, , Vietnam" },
      releasedDate: "2026-08-26T09:52:38.504Z",
    };

    const withDetail = buildSmartRecruitersJob(item, "Grab", "Grab", {
      postingUrl: "https://jobs.smartrecruiters.com/Grab/744000145701349-senior-software-engineer-fullstack",
      jobAd: { sections: { jobDescription: { text: "<p>Design, build and operate.</p>" } } },
    });
    expect(withDetail.url).toBe(
      "https://jobs.smartrecruiters.com/Grab/744000145701349-senior-software-engineer-fullstack",
    );
    expect(withDetail.description).toContain("Design, build and operate");
    expect(withDetail.source).toBe("ats:smartrecruiters");
    expect(withDetail.location).toBe("HCMC, , Vietnam");

    const withoutDetail = buildSmartRecruitersJob(item, "Grab", "Grab", null);
    expect(withoutDetail.url).toBe("https://jobs.smartrecruiters.com/Grab/744000145701349");
    expect(withoutDetail.description).toBe("");
  });
});

describe("Workday", () => {
  it("parseWorkdayBoard splits tenant/wdNumber/site", () => {
    expect(parseWorkdayBoard("thales/wd3/Careers")).toEqual({ tenant: "thales", wdNumber: "wd3", site: "Careers" });
  });

  it("parseWorkdayBoard rejects a malformed identifier", () => {
    expect(() => parseWorkdayBoard("thales/wd3")).toThrow();
  });

  it("buildWorkdayJob builds the public URL and strips HTML from the detail description", () => {
    const job = buildWorkdayJob(
      {
        title: "Maintenance Technician 3rd Shift",
        externalPath: "/job/North-Kingstown/Maintenance-Technician-3rd-Shift_R0336998-1",
        locationsText: "North Kingstown",
        postedOn: "Posted 15 Days Ago",
      },
      "Thales",
      "thales/wd3/Careers",
      "<p>Thales people architect identity management solutions.</p>",
    );

    expect(job.source).toBe("ats:workday");
    expect(job.company).toBe("Thales");
    expect(job.url).toBe(
      "https://thales.wd3.myworkdayjobs.com/Careers/job/North-Kingstown/Maintenance-Technician-3rd-Shift_R0336998-1",
    );
    expect(job.description).toContain("identity management");
    expect(job.description).not.toContain("<p>");
    expect(job.salaryRange).toBeNull();
  });

  it("buildWorkdayJob copes with a missing description", () => {
    const job = buildWorkdayJob(
      { title: "Role", externalPath: "/job/x", locationsText: "Paris", postedOn: "Posted Today" },
      "Acme",
      "acme/wd1/Careers",
      null,
    );
    expect(job.description).toBe("");
  });
});
