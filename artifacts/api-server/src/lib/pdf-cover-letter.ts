// Renders a cover letter PDF on the fly from a job's tailored letter text.
// pdfkit is externalized in build.mjs: it resolves its bundled AFM font
// metrics/data files at runtime via paths relative to its own package
// directory (e.g. `__dirname + "/data/Helvetica.afm"`), which breaks once
// esbuild inlines the module into a single bundled file whose __dirname no
// longer sits next to those assets.
//
// The letterhead (name / e-mail / phone / city) and the date line's locale
// come from `contact` and `candidate.nativeLanguage` in
// jobblast.config.json - nothing personal is hardcoded here.
import PDFDocument from "pdfkit";
import { loadConfig } from "./config";

/** Builds "email · phone · city", skipping whatever isn't configured. */
function contactLine(contact: { email: string; phone: string; city: string }): string {
  return [contact.email, contact.phone, contact.city]
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .join(" · ");
}

/** "Paris, le 13 août 2026" in French, "Paris, August 13, 2026" elsewhere. */
function dateLine(city: string, language: string, date: Date): string {
  const locale = language.trim() || "en";
  let formatted: string;
  try {
    formatted = new Intl.DateTimeFormat(locale, {
      day: "numeric",
      month: "long",
      year: "numeric",
    }).format(date);
  } catch {
    formatted = date.toISOString().slice(0, 10);
  }

  const place = city.trim();
  if (!place) return formatted;
  // French letters conventionally write "<city>, le <date>".
  return locale.toLowerCase().startsWith("fr") ? `${place}, le ${formatted}` : `${place}, ${formatted}`;
}

/**
 * Builds a simple, clean A4 cover letter PDF and returns the PDFDocument
 * (a readable stream) - callers pipe it directly to an HTTP response or a
 * file. `doc.end()` is already called; do not call it again.
 */
export function renderCoverLetterPdf(params: { letter: string; date?: Date }): PDFKit.PDFDocument {
  const { contact, candidate } = loadConfig();

  const doc = new PDFDocument({
    size: "A4",
    margins: { top: 72, bottom: 72, left: 72, right: 72 },
  });

  const nameHeader = contact.name.trim();
  if (nameHeader) {
    doc.font("Helvetica-Bold").fontSize(18).fillColor("#111111").text(nameHeader);
    doc.moveDown(0.35);
  }

  const contacts = contactLine(contact);
  if (contacts) {
    doc.font("Helvetica").fontSize(10).fillColor("#555555").text(contacts);
  }
  doc.fillColor("#111111");
  doc.moveDown(1.4);

  doc
    .font("Helvetica")
    .fontSize(10)
    .text(dateLine(contact.city, candidate.nativeLanguage, params.date ?? new Date()), { align: "right" });
  doc.moveDown(1.6);

  doc.font("Helvetica").fontSize(11).text(params.letter, {
    align: "left",
    lineGap: 4,
  });

  doc.end();
  return doc;
}

/** Sanitizes a company name into a safe PDF filename segment. */
export function sanitizeFilenameSegment(value: string): string {
  const cleaned = value
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "") // strip combining accents (e.g. e + combining acute)
    .replace(/[^a-zA-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return cleaned || "Company";
}
