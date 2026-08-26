import { defineConfig } from "vitest/config";

// Lot G3: HTTP-only E2E suite against the SaaS Docker stack
// (deploy/saas/compose.yaml, docs/DOCKER.md). Entirely separate from
// artifacts/api-server/vitest.config.ts's pure-logic unit suite - these
// specs make real fetch() calls to a running stack and are never part of
// `pnpm test`. Run via `pnpm run test:e2e` from the repo root, which checks
// the stack is up first (tests/e2e/run.mjs).
export default defineConfig({
  test: {
    include: ["specs/**/*.e2e.test.ts"],
    // Specs share a small, deliberately scarce resource: invite codes minted
    // via `docker exec`, and the server's own per-IP registration rate limit
    // (5/hour - docs/SAAS-ARCHITECTURE.md section 2). Running spec FILES
    // sequentially keeps the account count, and the run's behavior, easy to
    // reason about; each file's own test cases still run in the declared
    // order (Vitest's default), which matters here since later steps in a
    // spec depend on state earlier steps created (registered account,
    // session cookie).
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
