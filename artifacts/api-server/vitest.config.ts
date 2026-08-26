import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    // gmail-sync.ts imports @workspace/db, which throws at import time if
    // DATABASE_URL is unset (see lib/db/src/index.ts). The tests never touch
    // the database - pg's Pool only connects lazily on first query - so a
    // fake, never-dialed connection string is enough to let the module load.
    // This keeps `pnpm test` runnable with no .env, no Docker, no Postgres.
    env: {
      DATABASE_URL: "postgres://test:test@localhost:5432/jobblast_test_unused",
    },
  },
});
