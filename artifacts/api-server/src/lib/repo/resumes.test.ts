import { describe, expect, it } from "vitest";
import { RESUME_CAP, validateCreateResume, validateDeleteResume } from "./resumes";

describe("validateCreateResume", () => {
  it("allows creating a resume below the cap", () => {
    expect(validateCreateResume(0)).toEqual({ ok: true });
    expect(validateCreateResume(RESUME_CAP - 1)).toEqual({ ok: true });
  });

  it("refuses to create a resume once the account already has RESUME_CAP", () => {
    expect(validateCreateResume(RESUME_CAP)).toEqual({ ok: false, error: "cap-reached" });
  });

  it("still refuses above the cap (defensive - should never happen)", () => {
    expect(validateCreateResume(RESUME_CAP + 1)).toEqual({ ok: false, error: "cap-reached" });
  });

  it("RESUME_CAP is 5, per this lot's spec", () => {
    expect(RESUME_CAP).toBe(5);
  });
});

describe("validateDeleteResume", () => {
  it("refuses to delete an account's only resume", () => {
    expect(validateDeleteResume(1)).toEqual({ ok: false, error: "last-resume" });
  });

  it("refuses on a count of zero too (defensive - should never happen)", () => {
    expect(validateDeleteResume(0)).toEqual({ ok: false, error: "last-resume" });
  });

  it("allows deleting one of several resumes", () => {
    expect(validateDeleteResume(2)).toEqual({ ok: true });
    expect(validateDeleteResume(RESUME_CAP)).toEqual({ ok: true });
  });
});
