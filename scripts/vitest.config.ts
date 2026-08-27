import { defineConfig } from "vitest/config";

// Lot H6: pure-logic tests for catalog-candidates.ts's aggregation/diff
// function. No database, no filesystem - see catalog-candidates.test.ts.
export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
  },
});
