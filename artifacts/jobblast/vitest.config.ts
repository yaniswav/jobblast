import { defineConfig } from 'vitest/config';

// Lot H6: pure-logic unit tests for the smart-search helpers
// (src/lib/suggestions.ts) - plain string functions, no DOM needed, so this
// stays a minimal node-environment config rather than pulling in jsdom.
// Mirrors artifacts/api-server/vitest.config.ts and tests/e2e/vitest.config.ts's
// shape: one small config per package, wired into the root `pnpm test`.
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
  },
});
