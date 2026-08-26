// Company Watch, step 1: URL -> ATS + board. Table-tested because every
// pattern was verified against a real career page URL (see detect.ts's
// header comment and the lot H2 report) and a regression here silently
// breaks "paste this URL" for one specific ATS.

import { describe, expect, it } from "vitest";
import { detectAts } from "./detect";

describe("detectAts", () => {
  it.each([
    ["Greenhouse (boards.greenhouse.io)", "https://boards.greenhouse.io/datadog", "greenhouse", "datadog"],
    [
      "Greenhouse (job-boards.greenhouse.io)",
      "https://job-boards.greenhouse.io/embark/jobs/123",
      "greenhouse",
      "embark",
    ],
    ["Lever", "https://jobs.lever.co/qonto", "lever", "qonto"],
    ["Ashby", "https://jobs.ashbyhq.com/ramp", "ashby", "ramp"],
    ["Workable", "https://apply.workable.com/usercentrics", "workable", "usercentrics"],
    ["Recruitee", "https://helloprint.recruitee.com/o/some-job", "recruitee", "helloprint"],
    ["SmartRecruiters (careers subdomain)", "https://careers.smartrecruiters.com/Grab", "smartrecruiters", "Grab"],
    ["SmartRecruiters (jobs subdomain)", "https://jobs.smartrecruiters.com/Grab/12345", "smartrecruiters", "Grab"],
    ["Personio (.de)", "https://4401.jobs.personio.de/", "personio", "4401.de"],
    ["Personio (.com)", "https://acme.jobs.personio.com/job/1", "personio", "acme.com"],
    ["Workday, no locale", "https://thales.wd3.myworkdayjobs.com/Careers", "workday", "thales/wd3/Careers"],
    [
      "Workday, with locale",
      "https://thales.wd3.myworkdayjobs.com/en-US/Careers/job/Paris/Some-Role_R123",
      "workday",
      "thales/wd3/Careers",
    ],
  ] as const)("%s", (_name, url, ats, board) => {
    const result = detectAts(url);
    expect(result.supported).toBe(true);
    if (result.supported) {
      expect(result.ats).toBe(ats);
      expect(result.board).toBe(board);
      expect(result.label.length).toBeGreaterThan(0);
    }
  });

  it("derives a readable default label from the slug", () => {
    const result = detectAts("https://boards.greenhouse.io/agility-robotics");
    expect(result.supported).toBe(true);
    if (result.supported) expect(result.label).toBe("Agility Robotics");
  });

  it.each([
    ["not a URL at all", "not a url"],
    ["an unrelated site", "https://example.com/careers"],
    ["a bare Workable job permalink with no account", "https://apply.workable.com/j/5793CA0928"],
    ["a Workday host with no site segment", "https://thales.wd3.myworkdayjobs.com/"],
    ["an ftp URL", "ftp://boards.greenhouse.io/datadog"],
  ])("marks %s unsupported with a reason", (_name, url) => {
    const result = detectAts(url);
    expect(result.supported).toBe(false);
    if (!result.supported) expect(result.reason.length).toBeGreaterThan(0);
  });
});
