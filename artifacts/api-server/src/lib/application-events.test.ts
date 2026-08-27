import { describe, expect, it } from "vitest";
import {
  buildEmailDetectedPayload,
  buildEmailSubject,
  buildStatusChangedPayload,
  isApplicationEventKind,
  MAX_NOTE_CHARS,
  MAX_SUBJECT_CHARS,
  normalizeNoteText,
  recordApplicationEvent,
  truncate,
  type ApplicationEvent,
  type InsertApplicationEventFn,
  type InsertApplicationEventInput,
} from "./application-events";

describe("truncate", () => {
  it("returns short text unchanged", () => {
    expect(truncate("Recruiter reply", 120)).toBe("Recruiter reply");
  });

  it("collapses internal whitespace to single spaces", () => {
    expect(truncate("Recruiter   reply\n\nfrom  Acme", 120)).toBe("Recruiter reply from Acme");
  });

  it("trims and caps with an ellipsis, never exceeding maxChars", () => {
    const result = truncate("x".repeat(200), 20);
    expect(result.length).toBe(20);
    expect(result.endsWith("…")).toBe(true);
  });

  it("never produces something longer than maxChars even at the boundary", () => {
    const result = truncate("abcdefghij", 5);
    expect(result.length).toBeLessThanOrEqual(5);
  });
});

describe("isApplicationEventKind", () => {
  it.each(["applied", "status_changed", "followed_up", "note_added", "email_detected", "brief_generated"])(
    "accepts %s",
    (kind) => {
      expect(isApplicationEventKind(kind)).toBe(true);
    },
  );

  it("rejects an unknown string", () => {
    expect(isApplicationEventKind("archived")).toBe(false);
    expect(isApplicationEventKind("")).toBe(false);
  });
});

describe("buildStatusChangedPayload", () => {
  it("builds a manual payload with no subject", () => {
    const payload = buildStatusChangedPayload({ from: "approved", to: "applied", origin: "manual" });
    expect(payload).toEqual({ from: "approved", to: "applied", origin: "manual" });
    expect(payload.subject).toBeUndefined();
  });

  it("keeps a gmail-origin subject, truncated to the cap", () => {
    const subject = "y".repeat(200);
    const payload = buildStatusChangedPayload({ from: "applied", to: "interview", origin: "gmail", subject });
    expect(payload.origin).toBe("gmail");
    expect(payload.subject).toBeDefined();
    expect(payload.subject!.length).toBeLessThanOrEqual(MAX_SUBJECT_CHARS);
  });

  it("drops a blank subject rather than keeping an empty string", () => {
    const payload = buildStatusChangedPayload({ from: "applied", to: "rejected", origin: "gmail", subject: "   " });
    expect(payload.subject).toBeUndefined();
  });
});

describe("buildEmailSubject", () => {
  it("combines the kind label, company and sender", () => {
    expect(buildEmailSubject({ kindLabel: "Interview invitation", company: "Acme", from: "hr@acme.com" })).toBe(
      "Interview invitation - Acme (hr@acme.com)",
    );
  });

  it("omits the sender parenthetical when there is no sender", () => {
    expect(buildEmailSubject({ kindLabel: "Recruiter reply", company: "Acme", from: "" })).toBe(
      "Recruiter reply - Acme",
    );
  });

  it("never exceeds MAX_SUBJECT_CHARS, however long the inputs are", () => {
    const subject = buildEmailSubject({
      kindLabel: "Recruiter reply".repeat(10),
      company: "A very long company name indeed".repeat(5),
      from: "someone@example.com",
    });
    expect(subject.length).toBeLessThanOrEqual(MAX_SUBJECT_CHARS);
  });
});

describe("buildEmailDetectedPayload", () => {
  it("carries kind, verdict and a truncated subject", () => {
    const payload = buildEmailDetectedPayload({
      kind: "confirmation",
      verdict: "matched",
      subject: "Application confirmation - Acme (no-reply@acme.com)",
    });
    expect(payload).toEqual({
      kind: "confirmation",
      verdict: "matched",
      subject: "Application confirmation - Acme (no-reply@acme.com)",
    });
  });

  it("never lets a caller smuggle a long excerpt through as the subject", () => {
    const payload = buildEmailDetectedPayload({ kind: "reply", verdict: "matched", subject: "z".repeat(500) });
    expect(payload.subject.length).toBeLessThanOrEqual(MAX_SUBJECT_CHARS);
  });
});

describe("normalizeNoteText", () => {
  it("trims surrounding whitespace", () => {
    expect(normalizeNoteText("  Called the recruiter today.  ")).toBe("Called the recruiter today.");
  });

  it("rejects an empty (or whitespace-only) note", () => {
    expect(normalizeNoteText("")).toBeNull();
    expect(normalizeNoteText("   \n  ")).toBeNull();
  });

  it("accepts a note exactly at the cap", () => {
    const note = "a".repeat(MAX_NOTE_CHARS);
    expect(normalizeNoteText(note)).toBe(note);
  });

  it("rejects a note one character over the cap", () => {
    expect(normalizeNoteText("a".repeat(MAX_NOTE_CHARS + 1))).toBeNull();
  });
});

// recordApplicationEvent takes its DB write as an injectable last parameter
// (InsertApplicationEventFn) precisely so its "never throws" contract can be
// proven with a faithful fake here, instead of mocking
// ./repo/application-events - see that parameter's doc comment.
describe("recordApplicationEvent", () => {
  function fakeRow(overrides: Partial<ApplicationEvent> = {}): ApplicationEvent {
    return {
      id: 1,
      userId: "u1",
      applicationId: 7,
      kind: "note_added",
      occurredAt: new Date("2026-01-01T00:00:00Z"),
      payload: {},
      createdAt: new Date("2026-01-01T00:00:00Z"),
      ...overrides,
    };
  }

  it("returns the inserted row on success, calling the real interface with the built input", async () => {
    const row = fakeRow();
    const calls: Array<[string, InsertApplicationEventInput]> = [];
    const insert: InsertApplicationEventFn = async (userId, input) => {
      calls.push([userId, input]);
      return row;
    };

    const result = await recordApplicationEvent(
      "u1",
      7,
      { kind: "note_added", payload: { text: "hi" } },
      undefined,
      insert,
    );

    expect(result).toBe(row);
    expect(calls).toEqual([["u1", { applicationId: 7, kind: "note_added", payload: { text: "hi" } }]]);
  });

  it("passes occurredAt through to the insert input when given", async () => {
    const occurredAt = new Date("2026-01-01T00:00:00Z");
    const calls: InsertApplicationEventInput[] = [];
    const insert: InsertApplicationEventFn = async (_userId, input) => {
      calls.push(input);
      return fakeRow({ kind: "applied", occurredAt });
    };

    await recordApplicationEvent("u1", 7, { kind: "applied" }, occurredAt, insert);

    expect(calls).toEqual([{ applicationId: 7, kind: "applied", payload: {}, occurredAt }]);
  });

  // The core contract this lot depends on: a broken insert must never bubble
  // up and fail whatever action triggered it (creating an application,
  // changing its status, ...).
  it("swallows a failed insert and resolves to null instead of throwing", async () => {
    const failingInsert: InsertApplicationEventFn = async () => {
      throw new Error("connection reset");
    };

    await expect(
      recordApplicationEvent(
        "u1",
        7,
        { kind: "status_changed", payload: { from: "applied", to: "rejected", origin: "manual" } },
        undefined,
        failingInsert,
      ),
    ).resolves.toBeNull();
  });
});
