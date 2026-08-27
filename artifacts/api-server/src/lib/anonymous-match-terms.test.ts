import { describe, expect, it } from "vitest";
import { extractCvProfile, matchAnonymousCv, type PostingLike } from "./anonymous-match";

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

  // A plain `\b` word boundary silently fails right next to an accented
  // letter (see anonymous-match.ts's `bound()` comment) - these are the
  // specific regressions that check would have caught, for words the lot J1
  // rules match on either side of.
  it("detects a French trade term whether the CV is typed with or without accents", () => {
    expect(extractCvProfile("Électricien qualifié, 5 ans de métier.").skills.has("Électricien(ne)")).toBe(true);
    expect(extractCvProfile("Electricien qualifie, 5 ans de metier.").skills.has("Électricien(ne)")).toBe(true);
    expect(extractCvProfile("Diplômée kinésithérapeute depuis 2018.").skills.has("Kinésithérapeute")).toBe(true);
    expect(extractCvProfile("Je suis kiné en cabinet libéral.").skills.has("Kinésithérapeute")).toBe(true);
  });
});

// Lot J1: the matcher's original vocabulary (extractCvProfile's rules, see
// anonymous-match.ts) skewed entirely tech/business-function. These fake
// CVs - one per major non-tech trade, plus the pre-existing tech CV as a
// regression witness - check that a nurse, a salesperson, a forklift
// operator and a cook each extract several recognizable terms from their
// own CV, and that a tech-only witness CV keeps extracting exactly the same
// terms it did before this lot (no accidental new match on generic words
// like "engineer" or "built").
describe("extractCvProfile - non-tech trade coverage (lot J1)", () => {
  const CV_TECH_WITNESS = "Senior TypeScript engineer. Built React apps on AWS with Docker.";
  const CV_INFIRMIER =
    "Infirmier diplômé d'État, 5 ans d'expérience en EHPAD, bloc opératoire et gestion de la douleur.";
  const CV_COMMERCIAL =
    "Commercial terrain avec négociation B2B et prospection, chargé de clientèle en grande distribution.";
  const CV_CARISTE =
    "Cariste titulaire des CACES 1, 3 et 5, préparateur de commandes en entrepôt, conduite de chariot élévateur.";
  const CV_CUISINIER = "Cuisinier passionné, chef de partie en restaurant gastronomique, respect des normes HACCP.";

  it("tech witness CV: extracts exactly the same skills as before this lot (no regression)", () => {
    const profile = extractCvProfile(CV_TECH_WITNESS);
    expect(Array.from(profile.skills).sort()).toEqual(["AWS", "Docker", "React", "TypeScript"]);
  });

  it("infirmier CV: extracts at least 3 healthcare terms", () => {
    const profile = extractCvProfile(CV_INFIRMIER);
    expect(profile.skills.has("Infirmier/Nurse")).toBe(true);
    expect(profile.skills.has("EHPAD")).toBe(true);
    expect(profile.skills.has("Bloc opératoire")).toBe(true);
    expect(profile.skills.size).toBeGreaterThanOrEqual(3);
  });

  it("commercial CV: extracts at least 3 sales terms", () => {
    const profile = extractCvProfile(CV_COMMERCIAL);
    expect(profile.skills.has("Commercial (vente)")).toBe(true);
    expect(profile.skills.has("B2B/B2C")).toBe(true);
    expect(profile.skills.has("Grande distribution")).toBe(true);
    expect(profile.skills.size).toBeGreaterThanOrEqual(3);
  });

  it("cariste CV: extracts at least 3 logistics terms", () => {
    const profile = extractCvProfile(CV_CARISTE);
    expect(profile.skills.has("Cariste")).toBe(true);
    expect(profile.skills.has("CACES")).toBe(true);
    expect(profile.skills.has("Préparateur de commandes")).toBe(true);
    expect(profile.skills.has("Entrepôt")).toBe(true);
    expect(profile.skills.size).toBeGreaterThanOrEqual(3);
  });

  it("cuisinier CV: extracts at least 3 hospitality terms", () => {
    const profile = extractCvProfile(CV_CUISINIER);
    expect(profile.skills.has("Cuisinier(ère)")).toBe(true);
    expect(profile.skills.has("Chef de partie")).toBe(true);
    expect(profile.skills.has("HACCP")).toBe(true);
    expect(profile.skills.size).toBeGreaterThanOrEqual(3);
  });

  it("no CV picks up a skill from an unrelated trade (no cross-domain false positive)", () => {
    const TECH_ONLY = new Set(["TypeScript", "React", "AWS", "Docker"]);
    const nonTechCvs = [CV_INFIRMIER, CV_COMMERCIAL, CV_CARISTE, CV_CUISINIER];
    for (const cv of nonTechCvs) {
      const skills = extractCvProfile(cv).skills;
      for (const techSkill of TECH_ONLY) {
        expect(skills.has(techSkill)).toBe(false);
      }
    }
    // And the tech witness doesn't pick up any of the new trade terms either.
    const techSkills = extractCvProfile(CV_TECH_WITNESS).skills;
    for (const tradeSkill of [
      "Infirmier/Nurse",
      "Commercial (vente)",
      "Cariste",
      "Cuisinier(ère)",
      "Maçon(nerie)",
    ]) {
      expect(techSkills.has(tradeSkill)).toBe(false);
    }
  });

  // Proof that opening the vocabulary doesn't just extract terms but changes
  // real matching outcomes: in a pool mixing tech and non-tech postings, the
  // right domain wins the top spots for each non-tech CV - never the tech
  // postings.
  describe("matchAnonymousCv - the right domain wins in a mixed pool", () => {
    let nextId = 1;
    function posting(overrides: Partial<PostingLike>): PostingLike {
      return {
        id: nextId++,
        company: "Acme",
        location: "France",
        workMode: "On-site",
        description: "",
        ...overrides,
      } as PostingLike;
    }

    const MIXED_POOL: PostingLike[] = [
      posting({
        title: "Senior Backend Engineer",
        description: "TypeScript, Node.js, AWS, Docker, PostgreSQL.",
      }),
      posting({
        title: "Full-Stack Developer",
        description: "React, TypeScript and Docker daily, deployed on AWS.",
      }),
      posting({
        title: "Infirmier(ère) DE - EHPAD",
        description: "Soins infirmiers en EHPAD, bloc opératoire occasionnel.",
      }),
      posting({
        title: "Infirmier bloc opératoire",
        description: "Poste d'infirmier en bloc opératoire, EHPAD en renfort.",
      }),
      posting({
        title: "Commercial terrain B2B",
        description: "Négociation B2B, prospection, chargé de clientèle grande distribution.",
      }),
      posting({
        title: "Chargé de clientèle grande distribution",
        description: "Poste commercial en négociation B2B avec un fort esprit de prospection.",
      }),
      posting({
        title: "Cariste CACES",
        description: "Cariste avec CACES à jour, préparateur de commandes en entrepôt.",
      }),
      posting({
        title: "Préparateur de commandes entrepôt",
        description: "Cariste CACES requis, poste en entrepôt logistique.",
      }),
      posting({
        title: "Cuisinier - Chef de partie",
        description: "Restaurant gastronomique, respect des normes HACCP.",
      }),
      posting({
        title: "Chef de partie cuisine",
        description: "Cuisinier expérimenté, HACCP maîtrisé, restaurant gastronomique.",
      }),
    ];

    const TECH_TITLES = new Set(["Senior Backend Engineer", "Full-Stack Developer"]);

    it.each([
      ["infirmier", CV_INFIRMIER, ["Infirmier(ère) DE - EHPAD", "Infirmier bloc opératoire"]],
      [
        "commercial",
        CV_COMMERCIAL,
        ["Commercial terrain B2B", "Chargé de clientèle grande distribution"],
      ],
      ["cariste", CV_CARISTE, ["Cariste CACES", "Préparateur de commandes entrepôt"]],
      ["cuisinier", CV_CUISINIER, ["Cuisinier - Chef de partie", "Chef de partie cuisine"]],
    ] as const)("%s CV: both top matches are from the right domain, never tech", (_label, cv, expectedTitles) => {
      const result = matchAnonymousCv(cv, MIXED_POOL, { threshold: 1, minResultsToShow: 2 });
      expect(result.poolTooSmall).toBe(false);
      expect(result.matches).toHaveLength(2);
      const matchedTitles = result.matches.map((m) => m.title);
      expect(new Set(matchedTitles)).toEqual(new Set(expectedTitles));
      for (const title of matchedTitles) {
        expect(TECH_TITLES.has(title)).toBe(false);
      }
    });

    it("tech CV: both top matches are tech postings, never a trade posting", () => {
      const result = matchAnonymousCv(CV_TECH_WITNESS, MIXED_POOL, { threshold: 1, minResultsToShow: 2 });
      expect(result.poolTooSmall).toBe(false);
      expect(result.matches).toHaveLength(2);
      for (const match of result.matches) {
        expect(TECH_TITLES.has(match.title)).toBe(true);
      }
    });
  });
});
