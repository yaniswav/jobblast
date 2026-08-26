import { describe, expect, it } from "vitest";
import { extractCvProfile } from "./anonymous-match";

describe("extractCvProfile - term extraction", () => {
  it("detects skills mentioned anywhere in the CV text, case-insensitively", () => {
    const profile = extractCvProfile("Senior TypeScript engineer. Built React apps on AWS with Docker.");
    expect(profile.skills.has("TypeScript")).toBe(true);
    expect(profile.skills.has("React")).toBe(true);
    expect(profile.skills.has("AWS")).toBe(true);
    expect(profile.skills.has("Docker")).toBe(true);
  });

  it("does not detect skills the CV never mentions", () => {
    const profile = extractCvProfile("Full-stack developer working with Python and Django.");
    expect(profile.skills.has("Rust")).toBe(false);
    expect(profile.skills.has("Kubernetes")).toBe(false);
    expect(profile.skills.has("Marketing")).toBe(false);
  });

  it("does not false-positive Java on JavaScript, or vice versa", () => {
    const jsOnly = extractCvProfile("Five years of JavaScript, mostly frontend work.");
    expect(jsOnly.skills.has("JavaScript")).toBe(true);
    expect(jsOnly.skills.has("Java")).toBe(false);

    const javaOnly = extractCvProfile("Backend engineer, Java and Spring.");
    expect(javaOnly.skills.has("Java")).toBe(true);
    expect(javaOnly.skills.has("JavaScript")).toBe(false);
  });

  it("recognizes non-technical business functions the same way", () => {
    const profile = extractCvProfile("Product manager with a background in growth marketing and customer success.");
    expect(profile.skills.has("Product management")).toBe(true);
    expect(profile.skills.has("Marketing")).toBe(true);
    expect(profile.skills.has("Customer success")).toBe(true);
  });

  it("recognizes a French synonym alongside the English term", () => {
    const profile = extractCvProfile("Ingénieur en systèmes embarqués, gestion de projet.");
    expect(profile.skills.has("Embedded systems")).toBe(true);
    expect(profile.skills.has("Project management")).toBe(true);
  });

  it("flags a seniority signal from an explicit senior/lead title", () => {
    expect(extractCvProfile("Senior Backend Engineer at Acme.").seniorSignal).toBe(true);
    expect(extractCvProfile("Backend Engineer at Acme.").seniorSignal).toBe(false);
  });

  it("flags a seniority signal from a stated number of years of experience", () => {
    expect(extractCvProfile("Software engineer with 8 years of experience in backend systems.").seniorSignal).toBe(
      true,
    );
    expect(extractCvProfile("Software engineer with 2 years of experience in backend systems.").seniorSignal).toBe(
      false,
    );
  });

  it("returns an empty skill set for text with no recognizable terms", () => {
    const profile = extractCvProfile("Lorem ipsum dolor sit amet, consectetur adipiscing elit.");
    expect(profile.skills.size).toBe(0);
    expect(profile.seniorSignal).toBe(false);
  });
});
