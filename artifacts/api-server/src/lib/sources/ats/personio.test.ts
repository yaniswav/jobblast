// Personio XML feed parsing (Company Watch, lot H2). The fixture below is a
// trimmed, real response captured from https://4401.jobs.personio.de/xml
// while verifying this adapter (see the lot H2 report) - two positions, one
// with a description block and one without, since the feed legitimately
// returns both shapes.

import { describe, expect, it } from "vitest";
import { normalizePersonioPositions, parsePersonioXml } from "./personio";

const FIXTURE_XML = `<?xml version="1.0" encoding="UTF-8"?>
<workzag-jobs>
<position>
    <id>2746093</id>
    <office>Oman</office>
    <department>Engineering</department>
    <recruitingCategory>Employee</recruitingCategory>
    <name>Senior Process Engineer</name>
    <jobDescriptions>
        <jobDescription>
            <name>About The Role</name>
            <value><![CDATA[<p>As we scale our operations globally, we are looking for a <strong>Process Engineer</strong>.</p>]]></value>
        </jobDescription>
        <jobDescription>
            <name>Requirements</name>
            <value><![CDATA[<ul><li>5+ years experience</li></ul>]]></value>
        </jobDescription>
    </jobDescriptions>
    <employmentType>permanent</employmentType>
    <createdAt>2026-06-01T10:00:00+00:00</createdAt>
</position>
<position>
    <id>1834171</id>
    <office>Munich</office>
    <department>Product and Tech</department>
    <name>Staff Software Engineer, Data Platform</name>
    <jobDescriptions></jobDescriptions>
    <employmentType>permanent</employmentType>
    <createdAt>2024-11-13T14:10:41+00:00</createdAt>
</position>
</workzag-jobs>`;

describe("parsePersonioXml", () => {
  it("extracts every position with its joined description text", () => {
    const positions = parsePersonioXml(FIXTURE_XML);
    expect(positions).toHaveLength(2);

    expect(positions[0]).toMatchObject({
      id: "2746093",
      name: "Senior Process Engineer",
      office: "Oman",
      createdAt: "2026-06-01T10:00:00+00:00",
    });
    expect(positions[0]?.descriptionHtml).toContain("Process Engineer");
    expect(positions[0]?.descriptionHtml).toContain("5+ years experience");
  });

  it("tolerates a position with no job description blocks", () => {
    const positions = parsePersonioXml(FIXTURE_XML);
    expect(positions[1]?.descriptionHtml).toBe("");
  });

  it("returns an empty list for a feed with no positions", () => {
    expect(parsePersonioXml("<workzag-jobs></workzag-jobs>")).toEqual([]);
  });
});

describe("normalizePersonioPositions", () => {
  it("builds a RawJob per position, stripping HTML and building the job URL from company + tld", () => {
    const positions = parsePersonioXml(FIXTURE_XML);
    const jobs = normalizePersonioPositions(positions, "44.01", "4401.de");

    expect(jobs).toHaveLength(2);
    expect(jobs[0]).toMatchObject({
      source: "ats:personio",
      title: "Senior Process Engineer",
      company: "44.01",
      location: "Oman",
      url: "https://4401.jobs.personio.de/job/2746093",
      postedDate: "2026-06-01",
      salaryRange: null,
    });
    expect(jobs[0]?.description).toContain("Process Engineer");
    expect(jobs[0]?.description).not.toContain("<p>");

    expect(jobs[1]?.description).toBe("");
  });

  it("splits the .com TLD the same way", () => {
    const positions = parsePersonioXml(FIXTURE_XML);
    const jobs = normalizePersonioPositions(positions.slice(0, 1), "Acme", "acme.com");
    expect(jobs[0]?.url).toBe("https://acme.jobs.personio.com/job/2746093");
  });
});
