// Pure-logic tests for build-rome-suggestions.ts (lot K1): CSV parsing,
// gender-doublet splitting, curation, and the hand-rolled ZIP/XLSX readers,
// all exercised with synthetic fixtures - no network, no real ROME file.

import zlib from "node:zlib";
import { describe, expect, it } from "vitest";
import {
  curateRomeAppellations,
  MAX_APPELLATION_LENGTH,
  parseAppellationsCsv,
  parseFicheLabels,
  parseSharedStrings,
  readZipEntry,
  resolveArboPrincipaleTarget,
  splitGenderDoublet,
  toAppellationsCsv,
} from "./build-rome-suggestions";

describe("parseAppellationsCsv", () => {
  it("skips the header row and reads one appellation per line", () => {
    const csv = "appellation\nMaçon\nInfirmier / Infirmière\n";
    expect(parseAppellationsCsv(csv)).toEqual(["Maçon", "Infirmier / Infirmière"]);
  });

  it("unwraps a quoted field containing a comma", () => {
    const csv = 'appellation\n"Bioinformaticien / Bioinformaticienne en études, recherche et développement"\n';
    expect(parseAppellationsCsv(csv)).toEqual(["Bioinformaticien / Bioinformaticienne en études, recherche et développement"]);
  });

  it("decodes a doubled quote inside a quoted field to one literal quote", () => {
    const csv = 'appellation\n"Agent ""spécial"" mobile"\n';
    expect(parseAppellationsCsv(csv)).toEqual(['Agent "spécial" mobile']);
  });

  it("accepts both CRLF and LF line endings", () => {
    expect(parseAppellationsCsv("appellation\r\nMaçon\r\nSoudeur\r\n")).toEqual(["Maçon", "Soudeur"]);
    expect(parseAppellationsCsv("appellation\nMaçon\nSoudeur\n")).toEqual(["Maçon", "Soudeur"]);
  });

  it("ignores blank lines", () => {
    expect(parseAppellationsCsv("appellation\nMaçon\n\nSoudeur\n")).toEqual(["Maçon", "Soudeur"]);
  });

  it("returns an empty array for a header-only CSV", () => {
    expect(parseAppellationsCsv("appellation\n")).toEqual([]);
  });

  it("keeps a very long line intact (length filtering is curateRomeAppellations's job, not the parser's)", () => {
    const longLabel = "X".repeat(120);
    expect(parseAppellationsCsv(`appellation\n${longLabel}\n`)).toEqual([longLabel]);
  });
});

describe("toAppellationsCsv / parseAppellationsCsv round-trip", () => {
  it("round-trips plain labels", () => {
    const labels = ["Maçon", "Infirmier / Infirmière", "Développeur"];
    expect(parseAppellationsCsv(toAppellationsCsv(labels))).toEqual(labels);
  });

  it("round-trips a label containing a comma and a double quote", () => {
    const labels = ['Bioinformaticien, spécialité "recherche"'];
    expect(parseAppellationsCsv(toAppellationsCsv(labels))).toEqual(labels);
  });
});

describe("splitGenderDoublet", () => {
  it("reattaches the shared complement when the masculine side is a single bare word", () => {
    expect(splitGenderDoublet("Conducteur / Conductrice d'engins agricoles")).toEqual([
      "Conducteur d'engins agricoles",
      "Conductrice d'engins agricoles",
    ]);
  });

  it("keeps both sides as-is when the masculine side already has its own complement", () => {
    expect(splitGenderDoublet("Bûcheron élagueur / Bûcheronne élagueuse")).toEqual([
      "Bûcheron élagueur",
      "Bûcheronne élagueuse",
    ]);
  });

  it("handles a bare doublet with no complement on either side", () => {
    expect(splitGenderDoublet("Bûcheron / Bûcheronne")).toEqual(["Bûcheron", "Bûcheronne"]);
  });

  it("returns a single entry unsplit when there is no doublet", () => {
    expect(splitGenderDoublet("Maçon")).toEqual(["Maçon"]);
    expect(splitGenderDoublet("Garde nature")).toEqual(["Garde nature"]);
  });

  it("returns the label unsplit when the doublet shape is unexpected (more than one slash)", () => {
    expect(splitGenderDoublet("A / B / C")).toEqual(["A / B / C"]);
  });

  it("trims surrounding whitespace on both sides", () => {
    expect(splitGenderDoublet("  Maçon  /  Maçonne  ")).toEqual(["Maçon", "Maçonne"]);
  });
});

describe("curateRomeAppellations", () => {
  it("splits doublets, drops entries over MAX_APPELLATION_LENGTH, dedupes by fold, and sorts", () => {
    const longLabel = `${"A".repeat(MAX_APPELLATION_LENGTH + 10)} / ${"B".repeat(MAX_APPELLATION_LENGTH + 10)}`;
    const raw = ["Vendeur / Vendeuse", "Maçon", longLabel, "Maçon"];
    expect(curateRomeAppellations(raw)).toEqual(["Maçon", "Vendeur", "Vendeuse"]);
  });

  it("dedupes case- and accent-insensitively, keeping the first-seen spelling", () => {
    const raw = ["Développeur", "developpeur", "DÉVELOPPEUR"];
    expect(curateRomeAppellations(raw)).toEqual(["Développeur"]);
  });

  it("drops an entry that is exactly one character over the length bound, keeps one exactly at it", () => {
    const atBound = "X".repeat(MAX_APPELLATION_LENGTH);
    const overBound = "Y".repeat(MAX_APPELLATION_LENGTH + 1);
    expect(curateRomeAppellations([atBound, overBound])).toEqual([atBound]);
  });

  it("returns an empty array for empty input", () => {
    expect(curateRomeAppellations([])).toEqual([]);
  });

  it("is deterministic: the same input always yields the same, identically-ordered output", () => {
    const raw = ["Soudeur / Soudeuse", "Maçon", "Infirmier / Infirmière", "Comptable"];
    expect(curateRomeAppellations(raw)).toEqual(curateRomeAppellations(raw));
  });
});

describe("parseSharedStrings", () => {
  it("extracts plain <si><t>...</t></si> entries in order", () => {
    const xml = "<sst><si><t>A</t></si><si><t>Maçon</t></si></sst>";
    expect(parseSharedStrings(xml)).toEqual(["A", "Maçon"]);
  });

  it("concatenates rich-text runs within one <si>", () => {
    const xml = "<sst><si><r><t>Foo</t></r><r><t> Bar</t></r></si></sst>";
    expect(parseSharedStrings(xml)).toEqual(["Foo Bar"]);
  });

  it("decodes XML entities, including numeric ones", () => {
    const xml = "<sst><si><t>Tom &amp; Jerry &lt;3&gt; &quot;ok&quot; &apos;go&apos; &#233;t&#233;</t></si></sst>";
    expect(parseSharedStrings(xml)).toEqual([`Tom & Jerry <3> "ok" 'go' été`]);
  });

  it("returns an empty array when there are no <si> entries", () => {
    expect(parseSharedStrings("<sst></sst>")).toEqual([]);
  });
});

describe("parseFicheLabels", () => {
  it("extracts only the column-D label of outlineLevel=2 rows, in document order", () => {
    const sharedStrings = ["A", "Domain label", "11", "Sub-domain label", "01", "Fiche label", "Appellation 1", "Appellation 2"];
    const sheetXml = [
      '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="D1" t="s"><v>1</v></c></row>', // outline 0 (domain)
      '<row r="2" outlineLevel="1"><c r="A2" t="s"><v>0</v></c><c r="D2" t="s"><v>3</v></c></row>', // outline 1 (sub-domain)
      '<row r="3" outlineLevel="2"><c r="A3" t="s"><v>0</v></c><c r="D3" t="s"><v>5</v></c></row>', // outline 2 (fiche - kept)
      '<row r="4" outlineLevel="3"><c r="A4" t="s"><v>0</v></c><c r="D4" t="s"><v>6</v></c></row>', // outline 3 (appellation)
      '<row r="5" outlineLevel="3"><c r="A5" t="s"><v>0</v></c><c r="D5" t="s"><v>7</v></c></row>', // outline 3 (appellation)
    ].join("");
    expect(parseFicheLabels(sheetXml, sharedStrings)).toEqual(["Fiche label"]);
  });

  it("returns one label per fiche when several fiches are present", () => {
    const sharedStrings = ["Fiche One", "Fiche Two"];
    const sheetXml = [
      '<row r="1" outlineLevel="2"><c r="D1" t="s"><v>0</v></c></row>',
      '<row r="2" outlineLevel="2"><c r="D2" t="s"><v>1</v></c></row>',
    ].join("");
    expect(parseFicheLabels(sheetXml, sharedStrings)).toEqual(["Fiche One", "Fiche Two"]);
  });

  it("returns an empty array when no row is at outline level 2", () => {
    const sheetXml = '<row r="1"><c r="D1" t="s"><v>0</v></c></row>';
    expect(parseFicheLabels(sheetXml, ["Domain"])).toEqual([]);
  });
});

describe("resolveArboPrincipaleTarget", () => {
  const workbookXml =
    '<workbook><sheets>' +
    '<sheet name="Définition" r:id="rId3" sheetId="1"/>' +
    '<sheet name="Arbo Principale 15-06-2026" r:id="rId4" sheetId="2"/>' +
    "</sheets></workbook>";
  const relsXml =
    '<Relationships>' +
    '<Relationship Id="rId3" Target="worksheets/sheet1.xml"/>' +
    '<Relationship Id="rId4" Target="worksheets/sheet2.xml"/>' +
    "</Relationships>";

  it("resolves the sheet named 'Arbo Principale...' regardless of its trailing version date", () => {
    expect(resolveArboPrincipaleTarget(workbookXml, relsXml)).toBe("xl/worksheets/sheet2.xml");
  });

  it("throws when no sheet name starts with 'Arbo Principale'", () => {
    const noMatch = '<workbook><sheets><sheet name="Définition" r:id="rId3" sheetId="1"/></sheets></workbook>';
    expect(() => resolveArboPrincipaleTarget(noMatch, relsXml)).toThrow(/Arbo Principale/);
  });

  it("throws when the resolved relationship id has no matching Relationship entry", () => {
    const brokenRels = '<Relationships><Relationship Id="rId3" Target="worksheets/sheet1.xml"/></Relationships>';
    expect(() => resolveArboPrincipaleTarget(workbookXml, brokenRels)).toThrow(/rId4/);
  });
});

// -----------------------------------------------------------------------
// ZIP: builds tiny, valid ZIP archives by hand (both "stored" and
// "deflate" compression) so readZipEntry() is exercised without touching
// the network or a real XLSX file.
// -----------------------------------------------------------------------

function buildMinimalZip(entries: readonly { name: string; content: string; compress: boolean }[]): Buffer {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBuffer = Buffer.from(entry.name, "utf8");
    const contentBuffer = Buffer.from(entry.content, "utf8");
    const compressedBuffer = entry.compress ? zlib.deflateRawSync(contentBuffer) : contentBuffer;
    const compressionMethod = entry.compress ? 8 : 0;

    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4); // version needed
    localHeader.writeUInt16LE(0, 6); // flags
    localHeader.writeUInt16LE(compressionMethod, 8);
    localHeader.writeUInt16LE(0, 10); // mod time
    localHeader.writeUInt16LE(0, 12); // mod date
    localHeader.writeUInt32LE(0, 14); // crc32 (unused by readZipEntry)
    localHeader.writeUInt32LE(compressedBuffer.length, 18);
    localHeader.writeUInt32LE(contentBuffer.length, 22);
    localHeader.writeUInt16LE(nameBuffer.length, 26);
    localHeader.writeUInt16LE(0, 28); // extra length

    const localEntryOffset = offset;
    localParts.push(localHeader, nameBuffer, compressedBuffer);
    offset += localHeader.length + nameBuffer.length + compressedBuffer.length;

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(20, 4); // version made by
    centralHeader.writeUInt16LE(20, 6); // version needed
    centralHeader.writeUInt16LE(0, 8); // flags
    centralHeader.writeUInt16LE(compressionMethod, 10);
    centralHeader.writeUInt16LE(0, 12); // mod time
    centralHeader.writeUInt16LE(0, 14); // mod date
    centralHeader.writeUInt32LE(0, 16); // crc32
    centralHeader.writeUInt32LE(compressedBuffer.length, 20);
    centralHeader.writeUInt32LE(contentBuffer.length, 24);
    centralHeader.writeUInt16LE(nameBuffer.length, 28);
    centralHeader.writeUInt16LE(0, 30); // extra length
    centralHeader.writeUInt16LE(0, 32); // comment length
    centralHeader.writeUInt16LE(0, 34); // disk number
    centralHeader.writeUInt16LE(0, 36); // internal attrs
    centralHeader.writeUInt32LE(0, 38); // external attrs
    centralHeader.writeUInt32LE(localEntryOffset, 42);
    centralParts.push(centralHeader, nameBuffer);
  }

  const localSection = Buffer.concat(localParts);
  const centralSection = Buffer.concat(centralParts);

  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4); // disk number
  eocd.writeUInt16LE(0, 6); // disk with central directory
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralSection.length, 12);
  eocd.writeUInt32LE(localSection.length, 16); // central directory offset = end of local section
  eocd.writeUInt16LE(0, 20); // comment length

  return Buffer.concat([localSection, centralSection, eocd]);
}

describe("readZipEntry", () => {
  it("reads a stored (uncompressed) entry", () => {
    const zip = buildMinimalZip([{ name: "hello.txt", content: "Hello, ROME!", compress: false }]);
    expect(readZipEntry(zip, "hello.txt").toString("utf8")).toBe("Hello, ROME!");
  });

  it("reads a deflate-compressed entry", () => {
    const content = "Maçon,Infirmier / Infirmière,".repeat(50);
    const zip = buildMinimalZip([{ name: "data.csv", content, compress: true }]);
    expect(readZipEntry(zip, "data.csv").toString("utf8")).toBe(content);
  });

  it("finds the right entry among several", () => {
    const zip = buildMinimalZip([
      { name: "xl/workbook.xml", content: "<workbook/>", compress: false },
      { name: "xl/sharedStrings.xml", content: "<sst/>", compress: true },
    ]);
    expect(readZipEntry(zip, "xl/sharedStrings.xml").toString("utf8")).toBe("<sst/>");
    expect(readZipEntry(zip, "xl/workbook.xml").toString("utf8")).toBe("<workbook/>");
  });

  it("throws for a missing entry", () => {
    const zip = buildMinimalZip([{ name: "a.xml", content: "x", compress: false }]);
    expect(() => readZipEntry(zip, "missing.xml")).toThrow(/missing\.xml/);
  });

  it("throws for a buffer that is not a ZIP file", () => {
    expect(() => readZipEntry(Buffer.from("not a zip"), "anything")).toThrow(/end-of-central-directory/);
  });
});
