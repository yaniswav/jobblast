// Catalog integrity (lot H5) - no network. Re-runs detectAts() against each
// entry's own careerUrl, the same pure function the "paste a URL" path uses,
// so an entry whose board/ats drifted from what its own URL would produce
// fails loudly instead of silently 404ing at runtime. Does not re-verify the
// network side (a real fetch through the ATS's adapter) - see catalog.ts's
// header comment for that half.

import { describe, expect, it } from "vitest";
import { COMPANY_CATALOG } from "./catalog";
import { detectAts } from "./detect";

describe("COMPANY_CATALOG", () => {
  it("has at least 60 entries", () => {
    expect(COMPANY_CATALOG.length).toBeGreaterThanOrEqual(60);
  });

  it("has unique, lowercase-kebab ids", () => {
    const ids = COMPANY_CATALOG.map((entry) => entry.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) {
      expect(id).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
    }
  });

  it.each(COMPANY_CATALOG.map((entry) => [entry.id, entry] as const))(
    "%s's careerUrl round-trips through detectAts to its own ats/board",
    (_id, entry) => {
      const detection = detectAts(entry.careerUrl);
      expect(detection.supported).toBe(true);
      if (detection.supported) {
        expect(detection.ats).toBe(entry.ats);
        expect(detection.board).toBe(entry.board);
      }
    },
  );

  it("gives every entry a non-empty label and sector", () => {
    for (const entry of COMPANY_CATALOG) {
      expect(entry.label.trim().length).toBeGreaterThan(0);
      expect(entry.sector.trim().length).toBeGreaterThan(0);
    }
  });
});
