// Jooble response parsing (lot H3). Field names (title/location/snippet/
// salary/source/type/link/company/updated) match Jooble's documented POST
// https://jooble.org/api/{key} response shape - see jooble.ts's header
// comment. No real JOOBLE_API_KEY is available in this environment, so the
// network half (fetchJoobleJobs) can't be exercised against the live API;
// this covers the pure mapping instead.

import { describe, expect, it } from "vitest";
import { fetchJoobleJobs, normalizeJoobleJobs, type JoobleJob } from "./jooble";

const FIXTURE_JOBS: JoobleJob[] = [
  {
    id: 12345,
    title: "Développeur C++",
    location: "Paris, France",
    snippet: "Nous recherchons un développeur C++ expérimenté pour rejoindre notre équipe.",
    salary: "45000 - 55000 EUR",
    source: "indeed.fr",
    type: "Full-time",
    link: "https://jooble.org/desc/123",
    company: "Acme SAS",
    updated: "2026-08-20T10:00:00.0000000Z",
  },
  {
    // Minimal shape: Jooble only guarantees title + link, so every other
    // field has to degrade gracefully.
    title: "Ingénieur logiciel embarqué",
    link: "https://jooble.org/desc/456",
  },
];

describe("normalizeJoobleJobs", () => {
  it("maps a full job to a RawJob", () => {
    const [job] = normalizeJoobleJobs(FIXTURE_JOBS);
    expect(job).toMatchObject({
      source: "Jooble",
      title: "Développeur C++",
      company: "Acme SAS",
      location: "Paris, France",
      url: "https://jooble.org/desc/123",
      salaryRange: "45000 - 55000 EUR",
      postedDate: "2026-08-20",
    });
    expect(job?.description).toContain("Nous recherchons un développeur C++");
    expect(job?.description).toContain("Full-time");
  });

  it("degrades a minimal job (missing company/location/salary/updated) instead of throwing", () => {
    const [, job] = normalizeJoobleJobs(FIXTURE_JOBS);
    expect(job).toMatchObject({
      source: "Jooble",
      title: "Ingénieur logiciel embarqué",
      company: "Entreprise non communiquée",
      location: "",
      url: "https://jooble.org/desc/456",
      description: "",
      salaryRange: null,
    });
    // No `updated` field: falls back to today rather than an invalid date.
    expect(job?.postedDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("returns an empty list for an empty input", () => {
    expect(normalizeJoobleJobs([])).toEqual([]);
  });
});

describe("fetchJoobleJobs", () => {
  it("skips cleanly, with no network call, when JOOBLE_API_KEY is not set", async () => {
    const previous = process.env["JOOBLE_API_KEY"];
    delete process.env["JOOBLE_API_KEY"];
    try {
      await expect(fetchJoobleJobs()).resolves.toEqual([]);
    } finally {
      if (previous !== undefined) process.env["JOOBLE_API_KEY"] = previous;
    }
  });
});
