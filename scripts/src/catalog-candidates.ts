// Anonymous catalog-candidates report (lot H6): which watched companies are
// NOT yet in the built-in catalog (artifacts/api-server/src/lib/sources/ats/catalog.ts,
// lot H5), and how many accounts follow each one - the operator's worklist
// for promoting a company into the catalog. Promotion itself stays a manual
// edit/PR to catalog.ts (see that file's header); this script only surfaces
// candidates, it never writes anything.
//
//   pnpm run catalog-candidates            table. saas: reads every
//                                           account's user_settings row.
//                                           selfhosted: reads
//                                           jobblast.config.json (or
//                                           $JOBBLAST_CONFIG).
//   pnpm run catalog-candidates -- --json   same data as JSON
//
// Privacy (lot H6, see the Settings/privacy page's aggregation line): only
// aggregate counts ever leave this script's DB/file read - no user id, no
// email, no per-account breakdown. `diffCatalogCandidates` below is the pure
// boundary that enforces this shape; everything above it in the call graph
// only ever produces `{ ats, board, url, label }` rows with no account
// identifier attached in the first place.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const currentDir = path.dirname(fileURLToPath(import.meta.url));
// scripts/src -> scripts -> repo root
const REPO_ROOT = path.resolve(currentDir, "../..");

// Same reason as scripts/src/invite.ts and rotate-byok.ts: nothing loads the
// repo-root .env for a plain `tsx` process, and saas mode needs DATABASE_URL.
if (!process.env["DATABASE_URL"]) {
  const envFile = path.join(REPO_ROOT, ".env");
  if (fs.existsSync(envFile)) {
    for (const line of fs.readFileSync(envFile, "utf8").split(/\r?\n/)) {
      const match = /^\s*([\w.-]+)\s*=\s*(.*?)\s*$/.exec(line);
      if (match?.[1] && !process.env[match[1]]) {
        process.env[match[1]] = match[2]!.replace(/^["']|["']$/g, "");
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Pure core: aggregation + diff. No I/O, no account identifier - covered by
// catalog-candidates.test.ts.
// ---------------------------------------------------------------------------

/** One watched-company row, already stripped of any account identifier. */
export type WatchedCompanyRecord = { ats: string; board: string; url: string; label: string };

export type CatalogCandidate = {
  ats: string;
  board: string;
  url: string;
  label: string;
  /** How many accounts watch this company - the only "who" signal kept. */
  followerCount: number;
};

/**
 * Aggregates raw watched-company rows into anonymous per-company follower
 * counts, keyed by `${ats}:${board}` (the same pair Company Watch's own
 * dedup uses - see lib/sources/companies.ts's mergeCompanyBoards), and drops
 * anything already present in the catalog. Sorted by follower count
 * descending, ties broken alphabetically by label. Pure: same input always
 * yields the same output, and nothing here can leak an account id because
 * `WatchedCompanyRecord` never carries one.
 */
export function diffCatalogCandidates(
  watched: readonly WatchedCompanyRecord[],
  catalogKeys: ReadonlySet<string>,
): CatalogCandidate[] {
  const byKey = new Map<string, CatalogCandidate>();
  for (const entry of watched) {
    const key = `${entry.ats}:${entry.board}`;
    if (catalogKeys.has(key)) continue;
    const existing = byKey.get(key);
    if (existing) {
      existing.followerCount += 1;
    } else {
      byKey.set(key, { ats: entry.ats, board: entry.board, url: entry.url, label: entry.label, followerCount: 1 });
    }
  }
  return Array.from(byKey.values()).sort(
    (a, b) => b.followerCount - a.followerCount || a.label.localeCompare(b.label),
  );
}

/**
 * Parses COMPANY_CATALOG's `(ats, board)` pairs directly out of catalog.ts's
 * source text rather than importing it: scripts/ only depends on
 * @workspace/db today (rotate-byok.ts's header documents the same
 * reasoning - api-server is an application, not a library package), and this
 * script only ever needs the diff key set, not the full entry shape. Every
 * catalog entry is a `{ ..., ats: "...", board: "...", ... }` one-line
 * object literal, so a block-scoped extraction (order-independent within
 * each `{...}`) is resilient to field reordering without being a full
 * parser. Exported for the test file only.
 */
export function parseCatalogKeys(source: string): Set<string> {
  const keys = new Set<string>();
  const entryPattern = /\{[^{}]*\}/g;
  const atsPattern = /\bats:\s*"([a-z0-9]+)"/;
  const boardPattern = /\bboard:\s*"([^"]+)"/;
  for (const block of source.matchAll(entryPattern)) {
    const ats = atsPattern.exec(block[0])?.[1];
    const board = boardPattern.exec(block[0])?.[1];
    if (ats && board) keys.add(`${ats}:${board}`);
  }
  return keys;
}

/** Keeps only well-formed entries; a malformed row is dropped, not thrown on. */
export function parseWatchedCompanies(value: unknown): WatchedCompanyRecord[] {
  if (!Array.isArray(value)) return [];
  const records: WatchedCompanyRecord[] = [];
  for (const entry of value) {
    if (typeof entry !== "object" || entry === null) continue;
    const { ats, board, url, label } = entry as Record<string, unknown>;
    if (typeof ats === "string" && typeof board === "string" && typeof url === "string" && typeof label === "string") {
      records.push({ ats, board, url, label });
    }
  }
  return records;
}

// ---------------------------------------------------------------------------
// I/O: reading the catalog + the watched companies of every account.
// ---------------------------------------------------------------------------

const CATALOG_FILE = path.join(
  REPO_ROOT,
  "artifacts",
  "api-server",
  "src",
  "lib",
  "sources",
  "ats",
  "catalog.ts",
);

function readCatalogKeys(): Set<string> {
  const source = fs.readFileSync(CATALOG_FILE, "utf8");
  return parseCatalogKeys(source);
}

function resolveMode(): "saas" | "selfhosted" {
  return (process.env["JOBBLAST_MODE"] ?? "").trim().toLowerCase() === "saas" ? "saas" : "selfhosted";
}

/** Absolute path of the selfhosted config file (override with JOBBLAST_CONFIG). */
function selfhostedConfigPath(): string {
  const override = process.env["JOBBLAST_CONFIG"];
  if (override && override.trim().length > 0) return path.resolve(REPO_ROOT, override.trim());
  return path.join(REPO_ROOT, "jobblast.config.json");
}

type Gathered = { records: WatchedCompanyRecord[]; accountsScanned: number };

/** selfhosted: one account, one config file - watchedCompanies straight off disk. */
function watchedCompaniesFromFile(): Gathered {
  const file = selfhostedConfigPath();
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    // No config file: nothing watched, no account to count.
    return { records: [], accountsScanned: 0 };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    console.error(`Warning: ${file} is not valid JSON (${(err as Error).message}); treating as empty.`);
    return { records: [], accountsScanned: 0 };
  }

  const config = parsed as Record<string, unknown> | null;
  return { records: parseWatchedCompanies(config?.["watchedCompanies"]), accountsScanned: 1 };
}

/**
 * saas: every account's `user_settings.config.watchedCompanies`, read by
 * raw SQL (same style as scripts/src/rotate-byok.ts) rather than through
 * artifacts/api-server/src/lib/repo/ - that layer's every-function-takes-
 * userId contract (enforced by scoping.test.ts) is exactly wrong for an
 * operator tool that must aggregate ACROSS every account at once. `user_id`
 * itself is selected nowhere below - only the jsonb `config` column - so
 * there is nothing to redact, by construction.
 */
async function watchedCompaniesFromDatabase(): Promise<Gathered> {
  const { pool } = await import("@workspace/db");
  try {
    const { rows } = await pool.query<{ config: unknown }>("select config from user_settings");
    const records = rows.flatMap((row) => {
      const config = row.config as Record<string, unknown> | null;
      return parseWatchedCompanies(config?.["watchedCompanies"]);
    });
    return { records, accountsScanned: rows.length };
  } finally {
    await pool.end();
  }
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const asJson = process.argv.includes("--json");
  const mode = resolveMode();

  const catalogKeys = readCatalogKeys();
  const { records, accountsScanned } = mode === "saas" ? await watchedCompaniesFromDatabase() : watchedCompaniesFromFile();
  const candidates = diffCatalogCandidates(records, catalogKeys);

  if (asJson) {
    console.log(JSON.stringify({ mode, accountsScanned, candidates }, null, 2));
    return;
  }

  console.log(`Catalog candidates - mode: ${mode}, accounts scanned: ${accountsScanned}\n`);

  if (candidates.length === 0) {
    console.log("No candidates: every watched company is already in the catalog (or nothing is watched yet).");
    return;
  }

  console.table(
    candidates.map((candidate) => ({
      ats: candidate.ats,
      board: candidate.board,
      followers: candidate.followerCount,
      label: candidate.label,
      url: candidate.url,
    })),
  );
  console.log(`\n${candidates.length} candidate(s). No account identifiers are included above.`);
}

// Only auto-run when this file is the process entry point (`tsx
// ./src/catalog-candidates.ts`), not when catalog-candidates.test.ts imports
// its pure functions - importing this module must never read a real file,
// hit the database, or print anything.
const isMainModule = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMainModule) {
  await main();
}
