// Lot K1: generates artifacts/jobblast/src/lib/rome-roles.ts, a large,
// curated vocabulary of French job titles for the "target roles" tag
// autocomplete (suggestions.ts's ROLE_SUGGESTIONS, lots H6/J1) to scale
// from the ~140 hand-picked roles there to France Travail's full official
// occupational nomenclature, without hand-curating each entry.
//
//   pnpm run build-rome-suggestions                 downloads the official
//                                                    ROME file and writes
//                                                    rome-roles.ts
//   pnpm run build-rome-suggestions -- path/to.csv   reads a local CSV
//                                                    instead of downloading
//                                                    (reproducibility - see
//                                                    "Source data" below)
//
// Source data
// -----------
// France Travail, ROME 4.0 open data, dataset "Répertoire Opérationnel des
// Métiers et des Emplois (ROME)" on data.gouv.fr:
//   https://www.data.gouv.fr/datasets/repertoire-operationnel-des-metiers-et-des-emplois-rome
// resource "Les arborescences du ROME - Arborescence principale":
//   https://www.francetravail.org/files/live/sites/peorg/files/documents/Statistiques-et-analyses/Open-data/ROME/rome-arborescence-principale-juin-2026.xlsx
// (workbook sheet "Arbo Principale 15-06-2026"; dataset page last modified
// 18 juin 2026 per data.gouv.fr - ROME 4.0, 1911 fiches métier / 14301
// appellations as published there). License: Licence Ouverte / Etalab
// (data.gouv.fr license code "fr-lo"; full text linked from the dataset
// page as rome_licence_ouverte.pdf). Contains no personal data - the ROME
// is a public occupational taxonomy, not a dataset of people.
//
// This is the open-data path the lot K1 brief asked for, not the OAuth API
// (francetravail.io's "ROME 4.0" API) - deliberately avoided here, per the
// earlier "La Bonne Boîte" subscription failing invalid_scope. France
// Travail no longer seems to publish this dataset as a ready CSV either:
// the legacy api.francetravail.fr/api-nomenclatureemploi/v1/open-data/csv
// link still listed on the data.gouv.fr dataset page 404s directly (checked
// 2026-08-27) - that CSV export looks retired in favor of the (OAuth) API.
// The one resource that is both reachable with a plain HTTPS GET (no OAuth)
// and reliably versioned is the "Arborescence principale" XLSX above, so
// fetchRomeAppellationsCsv() below downloads that XLSX and converts it
// in-memory into the same one-column CSV shape parseAppellationsCsv() reads
// from a local file - the actual CSV parsing/curation core is exercised
// identically either way, and is what this file's test fixtures cover, with
// no dependency on knowing anything about XLSX/ZIP.
//
// Curation
// --------
// The ROME's full appellation list is 14301 entries - deliberately not what
// gets shipped (the lot's target is ~2000-4000; most of the 14301 are
// narrow synonyms of one another - regional wordings, employer-specific
// titles, near-duplicate phrasings of the same trade). Instead this script
// keeps each ROME "fiche métier"'s own principal appellation: ROME groups
// its 14301 appellations into 1911 fiches, one per recognized distinct
// occupation, and every fiche carries its own principal appellation - the
// name ROME itself treats as *the* canonical term for that trade. That is
// both the most standard/likely-typed term for the occupation and already
// deduplicated 1:1 with real distinct occupations, so a plain "keep the
// fiche-level label" filter (parseFicheLabels()) does the "appellation
// principale + les courantes" job the brief asked for on its own, with no
// extra synonym-picking heuristic needed.
//
// A ROME appellation commonly names both grammatical genders in one string,
// e.g. "Conducteur / Conductrice d'engins agricoles". Decided: split every
// such doublet into two standalone entries (splitGenderDoublet() below),
// matching this codebase's own convention already used for the 140 hand
// -picked ROLE_SUGGESTIONS/SKILL_SUGGESTIONS entries (lot J1: 'Infirmier'
// and 'Infirmière' are two separate list items, not one slash-joined
// string) - a user typing "infirmiere" should match directly, not depend on
// knowing the slash form. This isn't a bare `label.split(" / ")`: ROME's
// own convention only spells out a shared complement once, on the feminine
// side, when the masculine term is a single bare word (e.g. "Conducteur /
// Conductrice d'engins agricoles" -> "Conducteur d'engins agricoles" +
// "Conductrice d'engins agricoles" - the complement has to be reattached to
// the masculine side), but spells out both sides in full when the
// masculine already carries its own complement (e.g. "Bûcheron élagueur /
// Bûcheronne élagueuse" -> kept as the two already-complete phrases, no
// reattachment). Verified against all 1911 fiche labels at authoring time:
// no misfire (no identical masculine/feminine pair, no dropped complement,
// no mangled result) - see build-rome-suggestions.test.ts for the
// unit-level cases.
//
// After splitting: drop anything over MAX_APPELLATION_LENGTH characters
// (120 of the resulting 3368 split entries - a handful of very long
// official titles, e.g. long douane/pharma job names), dedupe case/accent
// -insensitively the same way suggestions.ts's own fold() does (16
// collisions at authoring time - a few fiches in different ROME domains
// sharing the same principal title, e.g. two different "Comptable"
// specializations), then sort. Result at authoring time: 3232 entries -
// squarely in the lot's 2000-4000 target, with no secondary/synonym
// appellations added on top of the fiche-level list.
//
// Not done, deliberately: no automatic new anonymous-match.ts KEYWORD_RULES
// generation from this list (that file stays hand-curated, see its own
// header - 500 auto-generated regexes would be a real false-positive risk
// the brief explicitly ruled out). Also not done: normalizing the source
// text itself (e.g. a few ROME labels use an inconsistent accent, such as
// "Elagueur" next to "Bûcheron élagueur" elsewhere in the same file, or an
// inline " -TIG-"/" -PME-" abbreviation instead of "(TIG)"/"(PME)") - that
// is left as published; this script curates *which* appellations to keep,
// not how France Travail chose to spell each one.

import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath, pathToFileURL } from "node:url";

const currentDir = path.dirname(fileURLToPath(import.meta.url));
// scripts/src -> scripts -> repo root
const REPO_ROOT = path.resolve(currentDir, "../..");

const OUTPUT_FILE = path.join(REPO_ROOT, "artifacts", "jobblast", "src", "lib", "rome-roles.ts");

const ROME_XLSX_URL =
  "https://www.francetravail.org/files/live/sites/peorg/files/documents/Statistiques-et-analyses/Open-data/ROME/rome-arborescence-principale-juin-2026.xlsx";

const ROME_DATASET_PAGE_URL =
  "https://www.data.gouv.fr/datasets/repertoire-operationnel-des-metiers-et-des-emplois-rome";

const ROME_LICENSE_URL =
  "https://www.francetravail.org/files/live/sites/peorg/files/documents/Statistiques-et-analyses/Open-data/ROME/rome_licence_ouverte.pdf";

// ---------------------------------------------------------------------------
// fold() - deliberately duplicated from artifacts/jobblast/src/lib/suggestions.ts
// rather than imported: scripts/ has no dependency on the jobblast app
// package (see catalog-candidates.ts's header for the same reasoning about
// scripts/ staying decoupled from artifacts/*), and this is five lines.
// Keep in sync with suggestions.ts's fold() if that one ever changes.
// ---------------------------------------------------------------------------

function fold(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "") // combining diacritical marks left behind by NFD
    .toLowerCase()
    .trim();
}

// ---------------------------------------------------------------------------
// CSV: a hand-rolled, dependency-free reader/writer for this script's own
// one-column "appellation" CSV shape (header row, then one ROME label per
// line, still with its " / " gender doublet if it has one). Not a general
// -purpose CSV library: quoted fields are supported (a handful of ROME
// labels contain a literal comma, e.g. "...en études, recherche et
// développement", so at least that much is required), doubled quotes ("")
// inside a quoted field decode to one quote, and both CRLF and LF line
// endings are accepted - but a field is never expected to contain an
// embedded newline (job titles don't), so each physical line is exactly one
// row, unlike a fully general CSV parser.
// ---------------------------------------------------------------------------

function parseCsvField(rawField: string): string {
  if (!rawField.startsWith('"')) return rawField.trim();
  let field = "";
  for (let i = 1; i < rawField.length; i++) {
    const char = rawField[i];
    if (char !== '"') {
      field += char;
      continue;
    }
    if (rawField[i + 1] === '"') {
      field += '"';
      i++;
    } else {
      break; // closing quote
    }
  }
  return field;
}

/** Parses this script's one-column appellation CSV. The header row (line 1) is always skipped; blank lines are ignored. */
export function parseAppellationsCsv(csvText: string): string[] {
  const lines = csvText.split(/\r\n|\n/);
  const appellations: string[] = [];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (line === undefined || line.length === 0) continue;
    appellations.push(parseCsvField(line));
  }
  return appellations;
}

function csvField(value: string): string {
  if (/["\n,]/.test(value)) return `"${value.replace(/"/g, '""')}"`;
  return value;
}

/** Serializes raw ROME labels into this script's one-column appellation CSV (the inverse of parseAppellationsCsv). */
export function toAppellationsCsv(appellations: readonly string[]): string {
  const lines = ["appellation"];
  for (const appellation of appellations) lines.push(csvField(appellation));
  return `${lines.join("\n")}\n`;
}

// ---------------------------------------------------------------------------
// Gender-doublet splitting - see the "Curation" section of this file's
// header comment for the rule and the reasoning.
// ---------------------------------------------------------------------------

/**
 * Splits a ROME masculine/feminine doublet into two standalone entries. A
 * label with no " / " (no doublet) or more than one (an unexpected shape)
 * is returned unsplit, as a single-element array.
 */
export function splitGenderDoublet(label: string): string[] {
  const parts = label.split(" / ");
  if (parts.length !== 2) return [label.trim()];

  const masculine = parts[0]!.trim();
  const feminine = parts[1]!.trim();
  const masculineWords = masculine.split(/\s+/);
  if (masculineWords.length > 1) return [masculine, feminine];

  // Bare single-word masculine: the feminine side carries the shared
  // complement (every word after its own first word) - reattach it.
  const feminineWords = feminine.split(/\s+/);
  const complement = feminineWords.slice(1).join(" ");
  const fullMasculine = complement.length > 0 ? `${masculine} ${complement}` : masculine;
  return [fullMasculine, feminine];
}

// ---------------------------------------------------------------------------
// Curation: raw fiche labels -> the final, sorted, deduplicated list.
// ---------------------------------------------------------------------------

/** Appellations longer than this are dropped (lot K1's bound). */
export const MAX_APPELLATION_LENGTH = 60;

/**
 * Turns raw ROME fiche labels (one per fiche, still possibly a " / "
 * doublet) into the final ROME_ROLE_SUGGESTIONS list: split every doublet,
 * drop anything over MAX_APPELLATION_LENGTH characters, dedupe case/accent
 * -insensitively (first occurrence wins), sort. Pure - the same input
 * always yields the same output, which is what makes the generated file
 * reproducible across runs.
 */
export function curateRomeAppellations(rawLabels: readonly string[]): string[] {
  const seen = new Set<string>();
  const curated: string[] = [];
  for (const rawLabel of rawLabels) {
    for (const entry of splitGenderDoublet(rawLabel)) {
      if (entry.length === 0 || entry.length > MAX_APPELLATION_LENGTH) continue;
      const key = fold(entry);
      if (seen.has(key)) continue;
      seen.add(key);
      curated.push(entry);
    }
  }
  return curated.sort((a, b) => a.localeCompare(b, "fr"));
}

// ---------------------------------------------------------------------------
// ZIP + XLSX: just enough of the ZIP format to read one text entry out of a
// flat, non-zip64, non-encrypted archive (an XLSX file is a ZIP of XML
// parts) - locate the end-of-central-directory record, find the named entry
// there (its compressed size is unambiguous there, unlike in its own local
// header, which can defer to a trailing data descriptor), jump to that
// entry's local header to find where its compressed bytes start, and
// inflate (compression method 8) or copy (method 0, stored). No dependency:
// zlib's raw-deflate inflater is a Node built-in.
// ---------------------------------------------------------------------------

const END_OF_CENTRAL_DIRECTORY_SIGNATURE = 0x06054b50;
const CENTRAL_DIRECTORY_ENTRY_SIGNATURE = 0x02014b50;
const LOCAL_FILE_HEADER_SIGNATURE = 0x04034b50;
const MIN_EOCD_SIZE = 22;
const MAX_ZIP_COMMENT_LENGTH = 65535;

type CentralDirectoryEntry = { name: string; compressionMethod: number; compressedSize: number; localHeaderOffset: number };
type EndOfCentralDirectory = { centralDirectoryOffset: number; entryCount: number };

function findEndOfCentralDirectory(zipBuffer: Buffer): EndOfCentralDirectory {
  const searchStart = Math.max(0, zipBuffer.length - MIN_EOCD_SIZE - MAX_ZIP_COMMENT_LENGTH);
  for (let offset = zipBuffer.length - MIN_EOCD_SIZE; offset >= searchStart; offset--) {
    if (zipBuffer.readUInt32LE(offset) === END_OF_CENTRAL_DIRECTORY_SIGNATURE) {
      return {
        entryCount: zipBuffer.readUInt16LE(offset + 10),
        centralDirectoryOffset: zipBuffer.readUInt32LE(offset + 16),
      };
    }
  }
  throw new Error("Not a valid ZIP file: end-of-central-directory record not found");
}

function parseCentralDirectory(zipBuffer: Buffer, centralDirectoryOffset: number, entryCount: number): CentralDirectoryEntry[] {
  const entries: CentralDirectoryEntry[] = [];
  let offset = centralDirectoryOffset;
  for (let i = 0; i < entryCount; i++) {
    if (zipBuffer.readUInt32LE(offset) !== CENTRAL_DIRECTORY_ENTRY_SIGNATURE) {
      throw new Error(`Malformed ZIP central directory entry at offset ${offset}`);
    }
    const compressionMethod = zipBuffer.readUInt16LE(offset + 10);
    const compressedSize = zipBuffer.readUInt32LE(offset + 20);
    const nameLength = zipBuffer.readUInt16LE(offset + 28);
    const extraLength = zipBuffer.readUInt16LE(offset + 30);
    const commentLength = zipBuffer.readUInt16LE(offset + 32);
    const localHeaderOffset = zipBuffer.readUInt32LE(offset + 42);
    const name = zipBuffer.toString("utf8", offset + 46, offset + 46 + nameLength);
    entries.push({ name, compressionMethod, compressedSize, localHeaderOffset });
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

/** Reads one entry's uncompressed bytes out of a ZIP archive buffer. See this section's header comment for the approach/limits. */
export function readZipEntry(zipBuffer: Buffer, entryName: string): Buffer {
  const { centralDirectoryOffset, entryCount } = findEndOfCentralDirectory(zipBuffer);
  const entries = parseCentralDirectory(zipBuffer, centralDirectoryOffset, entryCount);
  const entry = entries.find((candidate) => candidate.name === entryName);
  if (!entry) throw new Error(`ZIP entry not found: ${entryName}`);

  if (zipBuffer.readUInt32LE(entry.localHeaderOffset) !== LOCAL_FILE_HEADER_SIGNATURE) {
    throw new Error(`Malformed ZIP local header for entry: ${entryName}`);
  }
  const nameLength = zipBuffer.readUInt16LE(entry.localHeaderOffset + 26);
  const extraLength = zipBuffer.readUInt16LE(entry.localHeaderOffset + 28);
  const dataStart = entry.localHeaderOffset + 30 + nameLength + extraLength;
  const compressed = zipBuffer.subarray(dataStart, dataStart + entry.compressedSize);

  if (entry.compressionMethod === 0) return Buffer.from(compressed);
  if (entry.compressionMethod === 8) return zlib.inflateRawSync(compressed);
  throw new Error(`Unsupported ZIP compression method ${entry.compressionMethod} for entry: ${entryName}`);
}

function decodeXmlEntities(text: string): string {
  return text
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_match, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&amp;/g, "&");
}

/**
 * Parses an XLSX xl/sharedStrings.xml part into a flat, index-ordered array
 * of decoded text - a cell only ever references a whole `<si>` by index, so
 * any rich-text `<r><t>` runs within one `<si>` are concatenated.
 */
export function parseSharedStrings(sharedStringsXml: string): string[] {
  const strings: string[] = [];
  for (const siMatch of sharedStringsXml.matchAll(/<si>([\s\S]*?)<\/si>/g)) {
    let text = "";
    for (const tMatch of siMatch[1]!.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)) text += tMatch[1];
    strings.push(decodeXmlEntities(text));
  }
  return strings;
}

const OUTLINE_LEVEL_PATTERN = /outlineLevel="(\d+)"/;
const COLUMN_D_CELL_PATTERN = /<c r="D\d+"[^>]*t="s"[^>]*><v>(\d+)<\/v><\/c>/;

/**
 * Extracts the ROME "Arborescence principale" sheet's fiche-level rows -
 * the ones ROME itself indents at outline level 2 - and returns their
 * column-D label (the fiche's own principal appellation), in document
 * order. See this file's "ZIP + XLSX" section header for why this reads
 * raw sheet XML with a couple of targeted regexes rather than a general
 * spreadsheet parser: this script only ever needs one column from rows at
 * one known outline level, out of a sheet whose column layout (5 columns,
 * always present, one 0-indexed outline level per row) has stayed stable
 * across ROME 4.0 releases so far.
 */
export function parseFicheLabels(sheetXml: string, sharedStrings: readonly string[]): string[] {
  const labels: string[] = [];
  for (const rowMatch of sheetXml.matchAll(/<row([^>]*)>([\s\S]*?)<\/row>/g)) {
    const outlineMatch = OUTLINE_LEVEL_PATTERN.exec(rowMatch[1]!);
    const outlineLevel = outlineMatch ? Number(outlineMatch[1]) : 0;
    if (outlineLevel !== 2) continue;

    const columnDMatch = COLUMN_D_CELL_PATTERN.exec(rowMatch[2]!);
    if (!columnDMatch) continue;
    const label = sharedStrings[Number(columnDMatch[1])];
    if (label !== undefined) labels.push(label);
  }
  return labels;
}

/**
 * Resolves which worksheetN.xml inside the XLSX holds the "Arborescence
 * principale" data (not the small "Définition" legend sheet also present in
 * the workbook) by sheet name rather than a hardcoded "sheet2.xml" - the
 * sheet's own name carries a version date ("Arbo Principale 15-06-2026")
 * that changes release to release, but has so far always started with
 * "Arbo Principale".
 */
export function resolveArboPrincipaleTarget(workbookXml: string, workbookRelsXml: string): string {
  let relationshipId: string | undefined;
  for (const sheetMatch of workbookXml.matchAll(/<sheet[^>]*name="([^"]*)"[^>]*r:id="([^"]*)"/g)) {
    if (/^Arbo Principale/i.test(sheetMatch[1]!)) {
      relationshipId = sheetMatch[2];
      break;
    }
  }
  if (!relationshipId) throw new Error('Could not find a workbook sheet named "Arbo Principale..."');

  const relationshipMatch = new RegExp(`<Relationship Id="${relationshipId}"[^>]*Target="([^"]*)"`).exec(workbookRelsXml);
  if (!relationshipMatch) throw new Error(`Could not resolve workbook relationship ${relationshipId}`);
  return `xl/${relationshipMatch[1]}`;
}

async function downloadRomeXlsx(url: string): Promise<Buffer> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Failed to download ROME data: HTTP ${response.status} ${url}`);
  return Buffer.from(await response.arrayBuffer());
}

/** Downloads the official ROME XLSX and converts it into this script's one-column appellation CSV text (see this file's header for why). */
export async function fetchRomeAppellationsCsv(url: string): Promise<string> {
  const zipBuffer = await downloadRomeXlsx(url);
  const workbookXml = readZipEntry(zipBuffer, "xl/workbook.xml").toString("utf8");
  const workbookRelsXml = readZipEntry(zipBuffer, "xl/_rels/workbook.xml.rels").toString("utf8");
  const sheetTarget = resolveArboPrincipaleTarget(workbookXml, workbookRelsXml);

  const sharedStrings = parseSharedStrings(readZipEntry(zipBuffer, "xl/sharedStrings.xml").toString("utf8"));
  const sheetXml = readZipEntry(zipBuffer, sheetTarget).toString("utf8");
  return toAppellationsCsv(parseFicheLabels(sheetXml, sharedStrings));
}

// ---------------------------------------------------------------------------
// Output file
// ---------------------------------------------------------------------------

function toSingleQuotedLiteral(value: string): string {
  return `'${value.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
}

function renderOutputFile(entries: readonly string[]): string {
  const items = entries.map((entry) => `  ${toSingleQuotedLiteral(entry)},`).join("\n");
  return `// GENERATED FILE - do not edit by hand. Regenerate with:
//   pnpm run build-rome-suggestions [path-to-appellations.csv]
// See scripts/src/build-rome-suggestions.ts for the generator and the full
// curation writeup this header summarizes.
//
// Source: France Travail, ROME 4.0 open data, dataset "Répertoire
// Opérationnel des Métiers et des Emplois (ROME)":
//   ${ROME_DATASET_PAGE_URL}
// File: "Les arborescences du ROME - Arborescence principale":
//   ${ROME_XLSX_URL}
// License: Licence Ouverte / Etalab (data.gouv.fr license code "fr-lo"):
//   ${ROME_LICENSE_URL}
// Contains no personal data - the ROME is a public occupational taxonomy.
//
// Lot K1 (${entries.length} entries): each ROME "fiche métier"'s own
// principal appellation (one per recognized distinct occupation, 1911 of
// them as published), gender doublets ("Conducteur / Conductrice ...")
// split into two standalone entries, entries over ${MAX_APPELLATION_LENGTH} characters dropped,
// deduplicated case/accent-insensitively, sorted.

/** French ROME 4.0 job-title vocabulary, merged into suggestions.ts's ROLE_SUGGESTIONS (lot K1). */
export const ROME_ROLE_SUGGESTIONS: readonly string[] = [
${items}
];
`;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const localPath = process.argv[2];
  const csvText =
    localPath !== undefined
      ? fs.readFileSync(path.resolve(localPath), "utf8")
      : await (async () => {
          console.log(`Downloading ROME data from ${ROME_XLSX_URL} ...`);
          return fetchRomeAppellationsCsv(ROME_XLSX_URL);
        })();

  const rawLabels = parseAppellationsCsv(csvText);
  const curated = curateRomeAppellations(rawLabels);
  fs.writeFileSync(OUTPUT_FILE, renderOutputFile(curated), "utf8");
  console.log(`Wrote ${curated.length} entries to ${path.relative(REPO_ROOT, OUTPUT_FILE)}`);
}

// Only auto-run when this file is the process entry point (`tsx
// ./src/build-rome-suggestions.ts`), not when the test file imports its
// pure functions - importing this module must never download, read a real
// file, or write anything.
const isMainModule = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMainModule) {
  await main();
}
