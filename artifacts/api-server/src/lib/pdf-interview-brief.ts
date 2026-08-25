// Renders an interview prep brief (lib/ai/interview-brief.ts) to PDF, so the
// user can carry it into the interview instead of reading it in a browser
// tab. Same shape and constraints as lib/pdf-cover-letter.ts: pdfkit is
// externalized in build.mjs (it resolves its bundled AFM font metrics at
// runtime relative to its own package directory), and the letterhead comes
// from `contact` in jobblast.config.json rather than from anything hardcoded.
//
// The markdown renderer below is deliberately partial. The brief is written
// by our own prompt, which asks for exactly four constructs: "## " sections,
// "- " bullets, "1." numbered items and paragraphs. Anything else (tables,
// code fences, images) is out of scope; inline emphasis markers are stripped
// rather than styled, because a missing bold is invisible and a stray "**"
// is not.
import PDFDocument from "pdfkit";
import { loadConfig } from "./config";

/** Strips the inline markdown the renderer does not style. */
function toPlainText(line: string): string {
  return line
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/(^|\s)\*([^*]+)\*/g, "$1$2")
    .replace(/(^|\s)_([^_]+)_/g, "$1$2")
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, "$1 ($2)")
    .trim();
}

type Block =
  | { kind: "h2"; text: string }
  | { kind: "h3"; text: string }
  | { kind: "bullet"; text: string }
  | { kind: "numbered"; marker: string; text: string }
  | { kind: "paragraph"; text: string };

/** Exported for testability: markdown line -> the blocks the PDF draws. */
export function parseBriefMarkdown(markdown: string): Block[] {
  const blocks: Block[] = [];

  for (const rawLine of markdown.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0) continue;
    // A horizontal rule adds nothing once the sections are already spaced.
    if (/^([-*_])\1{2,}$/.test(line)) continue;

    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading?.[1] && heading[2]) {
      blocks.push({ kind: heading[1].length <= 2 ? "h2" : "h3", text: toPlainText(heading[2]) });
      continue;
    }

    const numbered = /^(\d+)[.)]\s+(.*)$/.exec(line);
    if (numbered?.[1] && numbered[2]) {
      blocks.push({ kind: "numbered", marker: `${numbered[1]}.`, text: toPlainText(numbered[2]) });
      continue;
    }

    const bullet = /^[-*+]\s+(.*)$/.exec(line);
    if (bullet?.[1]) {
      blocks.push({ kind: "bullet", text: toPlainText(bullet[1]) });
      continue;
    }

    blocks.push({ kind: "paragraph", text: toPlainText(line) });
  }

  return blocks;
}

/** "Generated 13 August 2026", in the candidate's own language. */
function generatedLine(language: string, date: Date): string {
  const locale = language.trim() || "en";
  try {
    return new Intl.DateTimeFormat(locale, { day: "numeric", month: "long", year: "numeric" }).format(date);
  } catch {
    return date.toISOString().slice(0, 10);
  }
}

/**
 * Builds the A4 brief PDF and returns the PDFDocument (a readable stream) -
 * callers pipe it straight to an HTTP response. `doc.end()` is already
 * called; do not call it again.
 */
export function renderInterviewBriefPdf(params: {
  company: string;
  title: string;
  markdown: string;
  generatedAt?: Date | null;
}): PDFKit.PDFDocument {
  const { contact, candidate } = loadConfig();

  const doc = new PDFDocument({
    size: "A4",
    margins: { top: 64, bottom: 64, left: 64, right: 64 },
  });

  doc.font("Helvetica-Bold").fontSize(18).fillColor("#111111").text(`Interview prep - ${params.company}`);
  doc.moveDown(0.3);

  const subtitle = [params.title, contact.name.trim()].filter((part) => part.length > 0).join(" · ");
  if (subtitle) {
    doc.font("Helvetica").fontSize(10).fillColor("#555555").text(subtitle);
  }
  if (params.generatedAt) {
    doc
      .font("Helvetica")
      .fontSize(9)
      .fillColor("#777777")
      .text(generatedLine(candidate.nativeLanguage, params.generatedAt));
  }

  doc.moveDown(0.8);
  doc
    .strokeColor("#dddddd")
    .lineWidth(1)
    .moveTo(doc.page.margins.left, doc.y)
    .lineTo(doc.page.width - doc.page.margins.right, doc.y)
    .stroke();
  doc.moveDown(0.9);

  const bulletIndent = 14;

  for (const block of parseBriefMarkdown(params.markdown)) {
    switch (block.kind) {
      case "h2":
        doc.moveDown(0.7);
        doc.font("Helvetica-Bold").fontSize(13).fillColor("#111111").text(block.text);
        doc.moveDown(0.35);
        break;
      case "h3":
        doc.moveDown(0.45);
        doc.font("Helvetica-Bold").fontSize(11).fillColor("#111111").text(block.text);
        doc.moveDown(0.2);
        break;
      case "bullet":
        doc
          .font("Helvetica")
          .fontSize(10.5)
          .fillColor("#222222")
          .text(`• ${block.text}`, doc.page.margins.left + bulletIndent, doc.y, {
            width: doc.page.width - doc.page.margins.left - doc.page.margins.right - bulletIndent,
            lineGap: 2,
          });
        doc.moveDown(0.25);
        break;
      case "numbered":
        doc
          .font("Helvetica")
          .fontSize(10.5)
          .fillColor("#222222")
          .text(`${block.marker} ${block.text}`, doc.page.margins.left + bulletIndent, doc.y, {
            width: doc.page.width - doc.page.margins.left - doc.page.margins.right - bulletIndent,
            lineGap: 2,
          });
        doc.moveDown(0.25);
        break;
      case "paragraph":
        doc
          .font("Helvetica")
          .fontSize(10.5)
          .fillColor("#222222")
          .text(block.text, doc.page.margins.left, doc.y, {
            width: doc.page.width - doc.page.margins.left - doc.page.margins.right,
            lineGap: 2,
            align: "left",
          });
        doc.moveDown(0.35);
        break;
    }
  }

  doc.end();
  return doc;
}
