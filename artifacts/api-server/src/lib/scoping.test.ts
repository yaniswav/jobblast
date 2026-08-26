// Layer 3 of the isolation model in docs/SAAS-ARCHITECTURE.md: a source-text
// guard that fails the build the moment somebody adds a route that queries
// the database directly, or a repository function that forgets to take the
// account it is acting for.
//
// Pure logic, no database, no ESLint config: it reads the files and asserts
// two rules.
//
//   1. No file in src/routes/ imports @workspace/db (or any *Table symbol).
//      Routes go through src/lib/repo/, which is where scoping lives.
//   2. Every exported async function in src/lib/repo/ names its first
//      parameter `userId`.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = path.dirname(fileURLToPath(import.meta.url));
const ROUTES_DIR = path.resolve(here, "../routes");
const REPO_DIR = path.resolve(here, "./repo");

function sourceFiles(dir: string): string[] {
  return fs
    .readdirSync(dir)
    .filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts"))
    .map((name) => path.join(dir, name));
}

describe("route files never query the database directly", () => {
  const files = sourceFiles(ROUTES_DIR);

  it("finds the route files", () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it.each(files.map((file) => [path.basename(file), file] as const))(
    "%s does not import @workspace/db",
    (_name, file) => {
      const source = fs.readFileSync(file, "utf8");
      expect(source).not.toMatch(/from\s+["']@workspace\/db["']/);
      // Catches `import { db } from "..."` re-exports and any drizzle table
      // symbol reaching a route by another path.
      expect(source).not.toMatch(/\b\w+Table\b/);
    },
  );
});

describe("every repository function is scoped by account", () => {
  const files = sourceFiles(REPO_DIR);

  it("finds the repository files", () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it.each(files.map((file) => [path.basename(file), file] as const))(
    "%s takes userId as the first parameter of every exported async function",
    (_name, file) => {
      const source = fs.readFileSync(file, "utf8");
      // `export async function name(` followed by the first parameter, which
      // may sit on the same line or on the next one (prettier wraps long
      // signatures).
      const pattern = /export\s+async\s+function\s+(\w+)\s*\(\s*([\w$]*)/g;
      const offenders: string[] = [];
      for (const match of source.matchAll(pattern)) {
        if (match[2] !== "userId") offenders.push(match[1] ?? "<anonymous>");
      }
      expect(offenders).toEqual([]);
    },
  );
});
