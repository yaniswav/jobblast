// First-run setup for a fresh clone: copies the three committed "example"
// files to their gitignored, editable counterparts, if (and only if) those
// counterparts don't already exist. Never overwrites anything - safe to run
// again later, e.g. after `git pull` adds a new example file.
//
// Run via `pnpm run setup` (root) or `pnpm --filter @workspace/scripts run setup`.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const currentDir = path.dirname(fileURLToPath(import.meta.url));
// scripts/src -> scripts -> repo root
const REPO_ROOT = path.resolve(currentDir, "../..");

type CopyTask = {
  from: string;
  to: string;
  /** Shown after a successful copy, e.g. what to edit next. */
  hint?: string;
};

const tasks: CopyTask[] = [
  {
    from: "jobblast.config.example.json",
    to: "jobblast.config.json",
    hint: "edit it to match your profile (contact, scoring, sources) - see docs/CONFIG.md",
  },
  {
    from: ".env.example",
    to: ".env",
    hint: "fill in DATABASE_URL and any job source API keys you have",
  },
  {
    from: path.join("config", "cover-letter-template.example.txt"),
    to: path.join("config", "cover-letter-template.txt"),
    hint: "replace the placeholder with your own standard cover letter",
  },
];

function main(): void {
  console.log("JobBlast setup: creating local config files from their committed examples...\n");

  let createdCount = 0;

  for (const task of tasks) {
    const fromPath = path.join(REPO_ROOT, task.from);
    const toPath = path.join(REPO_ROOT, task.to);

    if (fs.existsSync(toPath)) {
      console.log(`  skip    ${task.to} (already exists)`);
      continue;
    }

    if (!fs.existsSync(fromPath)) {
      console.warn(`  MISSING ${task.from} - can't create ${task.to}`);
      continue;
    }

    fs.mkdirSync(path.dirname(toPath), { recursive: true });
    fs.copyFileSync(fromPath, toPath);
    createdCount += 1;
    console.log(`  create  ${task.to}${task.hint ? ` - ${task.hint}` : ""}`);
  }

  console.log(
    createdCount > 0
      ? "\nDone. Next: start Postgres (docker compose up -d), then `pnpm --filter @workspace/db run push`."
      : "\nNothing to do - all local config files already exist.",
  );
}

main();
