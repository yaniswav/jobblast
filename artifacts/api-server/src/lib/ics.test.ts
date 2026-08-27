import { describe, expect, it } from "vitest";
import {
  buildInterviewIcs,
  buildInterviewUid,
  escapeIcsText,
  foldIcsLine,
  formatIcsUtc,
  ICS_DEFAULT_DURATION_MINUTES,
  type InterviewIcsInput,
} from "./ics";

const MAX_LINE_OCTETS = 75;

const baseInput: InterviewIcsInput = {
  applicationId: 42,
  title: "Senior Engineer",
  company: "Acme",
  location: "Paris, France",
  interviewAt: new Date("2026-08-30T14:00:00.000Z"),
  hasBrief: false,
  host: "jobblast.local",
  now: new Date("2026-08-27T09:00:00.000Z"),
};

describe("formatIcsUtc", () => {
  it("formats as YYYYMMDDTHHMMSSZ in UTC", () => {
    expect(formatIcsUtc(new Date("2026-08-30T14:05:09.000Z"))).toBe("20260830T140509Z");
  });

  it("zero-pads every component", () => {
    expect(formatIcsUtc(new Date("2026-01-02T03:04:05.000Z"))).toBe("20260102T030405Z");
  });
});

describe("escapeIcsText", () => {
  it("escapes backslashes first so it does not double-escape", () => {
    expect(escapeIcsText("a\\b")).toBe("a\\\\b");
  });

  it("escapes commas and semicolons", () => {
    expect(escapeIcsText("Acme, Inc; Paris")).toBe("Acme\\, Inc\\; Paris");
  });

  it("collapses line breaks to a literal backslash-n", () => {
    expect(escapeIcsText("line one\nline two")).toBe("line one\\nline two");
    expect(escapeIcsText("line one\r\nline two")).toBe("line one\\nline two");
  });

  it("leaves plain text untouched", () => {
    expect(escapeIcsText("Senior Engineer at Acme")).toBe("Senior Engineer at Acme");
  });
});

describe("foldIcsLine", () => {
  it("leaves a short line unfolded", () => {
    const line = "SUMMARY:Interview - Senior Engineer at Acme";
    expect(foldIcsLine(line)).toBe(line);
  });

  it("folds a long line at 75 octets, continuation lines starting with a space", () => {
    const line = `DESCRIPTION:${"x".repeat(200)}`;
    const folded = foldIcsLine(line);
    const physicalLines = folded.split("\r\n");
    expect(physicalLines.length).toBeGreaterThan(1);
    // Every physical line after the first is a continuation: starts with a
    // single space, and every physical line is at most 75 octets.
    for (const [index, physicalLine] of physicalLines.entries()) {
      expect(Buffer.byteLength(physicalLine, "utf8")).toBeLessThanOrEqual(MAX_LINE_OCTETS);
      if (index > 0) expect(physicalLine.startsWith(" ")).toBe(true);
    }
  });

  it("unfolds back to the original content by dropping CRLF + one leading space", () => {
    const original = `DESCRIPTION:${"abcdefghij".repeat(20)}`;
    const folded = foldIcsLine(original);
    const unfolded = folded.replace(/\r\n /g, "");
    expect(unfolded).toBe(original);
  });

  it("never splits a multi-byte UTF-8 character across a fold boundary", () => {
    // Accented characters are 2 octets each in UTF-8 - a naive char-count
    // fold would be fine here, but a naive byte-count fold without the
    // continuation-byte back-off could slice one in half.
    const original = `DESCRIPTION:${"é".repeat(100)}`;
    const folded = foldIcsLine(original);
    for (const physicalLine of folded.split("\r\n")) {
      const content = physicalLine.startsWith(" ") ? physicalLine.slice(1) : physicalLine;
      // A slice landing mid-character would produce the U+FFFD replacement
      // character when the bytes are decoded back to UTF-8 - Buffer.from
      // above already builds this from valid whole characters, so the
      // reconstructed string round-trips exactly if nothing was split.
      expect(content.includes("�")).toBe(false);
    }
    expect(folded.replace(/\r\n /g, "")).toBe(original);
  });
});

describe("buildInterviewUid", () => {
  it("is jobblast-app-<id>@<host>", () => {
    expect(buildInterviewUid(42, "jobblast.local")).toBe("jobblast-app-42@jobblast.local");
  });

  it("is stable across repeated calls with the same input", () => {
    expect(buildInterviewUid(7, "example.com")).toBe(buildInterviewUid(7, "example.com"));
  });

  it("differs by application id", () => {
    expect(buildInterviewUid(1, "example.com")).not.toBe(buildInterviewUid(2, "example.com"));
  });
});

/** Splits a generated .ics document into individual (unfolded) content lines for assertions. */
function unfoldedLines(ics: string): string[] {
  return ics
    .replace(/\r\n /g, "") // undo folding
    .split("\r\n")
    .filter((line) => line.length > 0);
}

describe("buildInterviewIcs", () => {
  it("is CRLF-terminated throughout, never a bare LF", () => {
    const ics = buildInterviewIcs(baseInput);
    expect(ics.includes("\r\n")).toBe(true);
    // Every LF is immediately preceded by a CR.
    for (let i = 0; i < ics.length; i++) {
      if (ics[i] === "\n") expect(ics[i - 1]).toBe("\r");
    }
  });

  it("has matched BEGIN/END pairs for VCALENDAR, VEVENT and VALARM", () => {
    const lines = unfoldedLines(buildInterviewIcs(baseInput));
    expect(lines[0]).toBe("BEGIN:VCALENDAR");
    expect(lines[lines.length - 1]).toBe("END:VCALENDAR");
    expect(lines).toContain("BEGIN:VEVENT");
    expect(lines).toContain("END:VEVENT");
    expect(lines).toContain("BEGIN:VALARM");
    expect(lines).toContain("END:VALARM");
    expect(lines.indexOf("BEGIN:VEVENT")).toBeLessThan(lines.indexOf("BEGIN:VALARM"));
    expect(lines.indexOf("BEGIN:VALARM")).toBeLessThan(lines.indexOf("END:VALARM"));
    expect(lines.indexOf("END:VALARM")).toBeLessThan(lines.indexOf("END:VEVENT"));
  });

  it("carries UID, DTSTAMP, DTSTART and DTEND, all in UTC", () => {
    const lines = unfoldedLines(buildInterviewIcs(baseInput));
    expect(lines).toContain("UID:jobblast-app-42@jobblast.local");
    expect(lines).toContain("DTSTAMP:20260827T090000Z");
    expect(lines).toContain("DTSTART:20260830T140000Z");
    expect(lines).toContain("DTEND:20260830T150000Z"); // default 1h duration
  });

  it("defaults the meeting duration to one hour", () => {
    expect(ICS_DEFAULT_DURATION_MINUTES).toBe(60);
  });

  it("builds an English SUMMARY by default", () => {
    const lines = unfoldedLines(buildInterviewIcs(baseInput));
    expect(lines).toContain("SUMMARY:Interview - Senior Engineer at Acme");
  });

  it("builds a French SUMMARY when locale is fr", () => {
    const lines = unfoldedLines(buildInterviewIcs({ ...baseInput, locale: "fr" }));
    expect(lines).toContain("SUMMARY:Entretien - Senior Engineer chez Acme");
  });

  it("includes LOCATION when set", () => {
    const lines = unfoldedLines(buildInterviewIcs(baseInput));
    expect(lines).toContain("LOCATION:Paris\\, France");
  });

  it("omits LOCATION when blank", () => {
    const lines = unfoldedLines(buildInterviewIcs({ ...baseInput, location: "  " }));
    expect(lines.some((line) => line.startsWith("LOCATION:"))).toBe(false);
  });

  it("mentions the brief only when hasBrief is true, and never quotes it", () => {
    const withoutBrief = buildInterviewIcs({ ...baseInput, hasBrief: false });
    expect(withoutBrief).not.toContain("brief");
    expect(withoutBrief).not.toContain("Brief");

    const withBrief = unfoldedLines(buildInterviewIcs({ ...baseInput, hasBrief: true }));
    const description = withBrief.find((line) => line.startsWith("DESCRIPTION:"));
    expect(description).toContain("Interview brief available in JobBlast.");
  });

  it("pins the DESCRIPTION down to exactly title, company, location and the brief mention - nothing else", () => {
    const lines = unfoldedLines(buildInterviewIcs({ ...baseInput, hasBrief: true }));
    const description = lines.find((line) => line.startsWith("DESCRIPTION:"));
    expect(description).toBe(
      "DESCRIPTION:Senior Engineer at Acme\\nParis\\, France\\n\\nInterview brief available in JobBlast.",
    );
  });

  it("escapes commas, semicolons and newlines in user-controlled fields", () => {
    const lines = unfoldedLines(
      buildInterviewIcs({
        ...baseInput,
        title: "Engineer, Backend; Platform",
        company: "Acme\nHoldings",
      }),
    );
    const summary = lines.find((line) => line.startsWith("SUMMARY:"));
    expect(summary).toBe("SUMMARY:Interview - Engineer\\, Backend\\; Platform at Acme\\nHoldings");
  });

  it("includes a VALARM firing one hour before, with a DISPLAY action", () => {
    const lines = unfoldedLines(buildInterviewIcs(baseInput));
    const alarmStart = lines.indexOf("BEGIN:VALARM");
    const alarmEnd = lines.indexOf("END:VALARM");
    const alarmBlock = lines.slice(alarmStart, alarmEnd + 1);
    expect(alarmBlock).toContain("ACTION:DISPLAY");
    expect(alarmBlock).toContain("TRIGGER:-PT1H");
  });

  it("produces a stable UID across repeated calls for the same application", () => {
    const first = unfoldedLines(buildInterviewIcs(baseInput)).find((line) => line.startsWith("UID:"));
    const second = unfoldedLines(buildInterviewIcs({ ...baseInput, now: new Date() })).find((line) =>
      line.startsWith("UID:"),
    );
    expect(first).toBe(second);
  });

  it("defaults DTSTAMP to now (well-formed) when not provided", () => {
    const lines = unfoldedLines(buildInterviewIcs({ ...baseInput, now: undefined }));
    const dtstamp = lines.find((line) => line.startsWith("DTSTAMP:"))?.slice("DTSTAMP:".length);
    expect(dtstamp).toMatch(/^\d{8}T\d{6}Z$/);
  });
});
