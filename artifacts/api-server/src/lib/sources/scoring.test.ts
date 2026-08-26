import path from "node:path";
import os from "node:os";
import { describe, expect, it } from "vitest";
import { scoreJob } from "./scoring";
import type { RawJob } from "./types";

// scoreJob() reads its rules through config.ts's loadConfig(), which is
// cached forever after the first call, and scoring.ts caches its *compiled*
// rules forever too (no reset hook exported). So the config used here has to
// be pinned before the very first scoreJob() call in this file, and it stays
// fixed for every test below - which is exactly what "score against the
// DEFAULT config" requires anyway. Pointing JOBBLAST_CONFIG at a path that
// cannot exist makes loadConfig() fall back to its built-in Zod defaults
// (see lib/config.ts) regardless of the developer's own, gitignored
// jobblast.config.json. Static imports above only define functions - they
// don't call loadConfig() - so setting this here, before any test body runs,
// is early enough.
process.env["JOBBLAST_CONFIG"] = path.join(os.tmpdir(), `jobblast-test-missing-${Date.now()}`, "jobblast.config.json");

function job(overrides: Partial<RawJob>): RawJob {
  return {
    source: "Greenhouse",
    title: "",
    company: "Acme",
    location: "",
    url: "https://example.com/job",
    description: "",
    postedDate: "2026-01-01",
    salaryRange: null,
    ...overrides,
  };
}

describe("scoreJob - default config", () => {
  it("weights a title match double a description-only match", () => {
    const inTitle = scoreJob(job({ title: "C++ Developer, remote", location: "Remote" }));
    const inDescription = scoreJob(
      job({ title: "Backend Developer, remote", description: "Looking for C++ experience.", location: "Remote" }),
    );
    expect(inTitle.relevanceScore).toBe(36); // 18 * 2
    expect(inTitle.matchReasons).toContain("C++ mentioned in the title");
    expect(inDescription.relevanceScore).toBe(18);
    expect(inDescription.matchReasons).toContain("C++ mentioned in the posting");
  });

  it("adds the configured location bonus when the location matches a target keyword", () => {
    const result = scoreJob(job({ title: "Widget Assembler", location: "Paris, France" }), ["paris"]);
    expect(result.relevanceScore).toBe(10);
    expect(result.matchReasons).toContain("Target location matched (Paris, France)");
  });

  // Fixed base score so each penalty's effect is visible without hitting the
  // 0 floor: "C++ Embedded Engineer" in the title is 18*2 + 14*2 = 64.
  const BASE_TITLE = "C++ Embedded Engineer";

  it.each([
    [
      "US work-authorization restriction (-40)",
      { title: BASE_TITLE, description: "Applicants must be US citizens.", location: "Remote" },
      24,
    ],
    [
      "5+ years experience requirement (-20)",
      { title: BASE_TITLE, description: "Looking for 7+ years of experience.", location: "Remote" },
      44,
    ],
    [
      "senior/staff/lead title (-18)",
      { title: `Senior ${BASE_TITLE}`, description: "", location: "Remote" },
      46,
    ],
    [
      "US location outside target areas (-15, remote so offsite doesn't also fire)",
      { title: BASE_TITLE, description: "", location: "New York, USA (remote)" },
      49,
    ],
    [
      "on-site outside target areas (-25)",
      { title: BASE_TITLE, description: "", location: "Berlin, Germany" },
      39,
    ],
  ] as const)("%s", (_label, fields, expected) => {
    expect(scoreJob(job(fields)).relevanceScore).toBe(expected);
  });

  it("does not apply the offsite penalty when a remote signal is present, even off-target", () => {
    const remote = scoreJob(job({ title: BASE_TITLE, location: "Anywhere" }));
    const onsite = scoreJob(job({ title: BASE_TITLE, location: "Denver, Colorado" }));
    expect(remote.relevanceScore).toBe(64);
    expect(onsite.relevanceScore).toBe(39); // 64 - 25 offsite penalty
  });

  it("floors the score at 0 instead of going negative", () => {
    const result = scoreJob(
      job({
        title: "Senior C++ Engineer",
        description: "Must be a US citizen. Requires 8+ years of experience.",
        location: "New York, USA",
      }),
    );
    expect(result.relevanceScore).toBe(0);
  });

  it("caps the score at the configured scoreCap instead of stacking past it", () => {
    const result = scoreJob(
      job({
        title: "DDS C++ Embedded Computer Vision Distributed Systems Engineer",
        location: "Paris, France",
      }),
      ["paris"],
    );
    expect(result.relevanceScore).toBe(98); // default scoring.scoreCap
  });
});
