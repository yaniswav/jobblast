import { describe, expect, it } from "vitest";
import { resumeOnboardingStep } from "./onboarding";

describe("resumeOnboardingStep", () => {
  it("sends a brand-new account (no resume, no criteria) to the profile step", () => {
    expect(resumeOnboardingStep({ hasResume: false, hasCriteria: false })).toBe("profile");
  });

  it("sends an account with no resume to the profile step, even with criteria already saved", () => {
    expect(resumeOnboardingStep({ hasResume: false, hasCriteria: true })).toBe("profile");
  });

  it("sends an account with a resume but no criteria to the criteria step", () => {
    expect(resumeOnboardingStep({ hasResume: true, hasCriteria: false })).toBe("criteria");
  });

  it("sends an account with both a resume and criteria to the byok step", () => {
    expect(resumeOnboardingStep({ hasResume: true, hasCriteria: true })).toBe("byok");
  });

  it("prioritizes the resume over criteria when both are missing", () => {
    // Not just "returns profile" - asserts the check order itself, since a
    // caller could otherwise flip the two conditions and still pass a test
    // that only checks the all-false / all-true corners.
    const step = resumeOnboardingStep({ hasResume: false, hasCriteria: false });
    expect(step).not.toBe("criteria");
    expect(step).not.toBe("byok");
  });
});
