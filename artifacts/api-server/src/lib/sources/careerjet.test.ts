// Careerjet response parsing (lot H3). Field names (title/company/locations/
// description/salary/date/url) match the v4/query response shape confirmed
// against Careerjet's official client docs and a live example response -
// see careerjet.ts's header comment. No real CAREERJET_API_KEY is available
// in this environment, so the network half (fetchCareerjetJobs) can't be
// exercised against the live API; this covers the pure mapping instead.

import { describe, expect, it } from "vitest";
import { fetchCareerjetJobs, normalizeCareerjetJobs, type CareerjetJob } from "./careerjet";

const FIXTURE_JOBS: CareerjetJob[] = [
  {
    title: "Développeur C++",
    company: "Acme SAS",
    locations: "Paris",
    description: "Nous recherchons un développeur C++ expérimenté pour rejoindre notre équipe.",
    salary: "45000",
    date: "2026-08-20 10:00:00",
    url: "https://www.careerjet.fr/jobad/123",
  },
  {
    // Minimal shape: only title + url are guaranteed.
    title: "Ingénieur logiciel embarqué",
    url: "https://www.careerjet.fr/jobad/456",
  },
];

describe("normalizeCareerjetJobs", () => {
  it("maps a full job to a RawJob", () => {
    const [job] = normalizeCareerjetJobs(FIXTURE_JOBS);
    expect(job).toMatchObject({
      source: "Careerjet",
      title: "Développeur C++",
      company: "Acme SAS",
      location: "Paris",
      url: "https://www.careerjet.fr/jobad/123",
      description: "Nous recherchons un développeur C++ expérimenté pour rejoindre notre équipe.",
      salaryRange: "45000",
      postedDate: "2026-08-20",
    });
  });

  it("degrades a minimal job (missing company/locations/description/salary/date) instead of throwing", () => {
    const [, job] = normalizeCareerjetJobs(FIXTURE_JOBS);
    expect(job).toMatchObject({
      source: "Careerjet",
      title: "Ingénieur logiciel embarqué",
      company: "Entreprise non communiquée",
      location: "",
      url: "https://www.careerjet.fr/jobad/456",
      description: "",
      salaryRange: null,
    });
    expect(job?.postedDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("returns an empty list for an empty input", () => {
    expect(normalizeCareerjetJobs([])).toEqual([]);
  });
});

describe("fetchCareerjetJobs", () => {
  it("skips cleanly, with no network call, when CAREERJET_API_KEY is not set", async () => {
    const previous = process.env["CAREERJET_API_KEY"];
    delete process.env["CAREERJET_API_KEY"];
    try {
      await expect(fetchCareerjetJobs()).resolves.toEqual([]);
    } finally {
      if (previous !== undefined) process.env["CAREERJET_API_KEY"] = previous;
    }
  });
});
