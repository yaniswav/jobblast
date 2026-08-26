import { describe, expect, it } from "vitest";
import { matchAnonymousCv, type PostingLike } from "./anonymous-match";

let nextId = 1;
function posting(overrides: Partial<PostingLike> = {}): PostingLike {
  return {
    id: nextId++,
    title: "Software Engineer",
    company: "Acme",
    location: "Remote",
    workMode: "Remote",
    description: "Join our team.",
    ...overrides,
  };
}

describe("matchAnonymousCv - scoring and threshold", () => {
  it("weights a title hit double a description-only hit for the same skill", () => {
    const result = matchAnonymousCv(
      "Rust developer.",
      [
        posting({ title: "Rust Engineer", description: "Join our platform team." }),
        posting({ title: "Backend Engineer", description: "We need someone experienced with Rust for backend services." }),
      ],
      { threshold: 5 },
    );

    expect(result.poolTooSmall).toBe(false);
    expect(result.totalMatches).toBe(2);
    expect(result.matches).toHaveLength(2);
    expect(result.matches[0]).toMatchObject({ title: "Rust Engineer", relevanceScore: 16 });
    expect(result.matches[1]).toMatchObject({ title: "Backend Engineer", relevanceScore: 8 });
  });

  it("only scores skills the CV itself mentions - an unrelated skill in the posting is ignored", () => {
    const result = matchAnonymousCv("Rust developer.", [posting({ title: "Senior Java Architect", description: "Java, Spring, Kubernetes." })], {
      threshold: 1,
      minResultsToShow: 1,
    });
    expect(result.matches).toHaveLength(0);
    expect(result.totalMatches).toBe(0);
  });

  it("falls back to the honest 'pool too small' result instead of forcing weak matches", () => {
    const onlyOneQualifies = matchAnonymousCv("Rust developer.", [posting({ title: "Rust Engineer" })], { threshold: 5 });
    expect(onlyOneQualifies.poolTooSmall).toBe(true);
    expect(onlyOneQualifies.matches).toEqual([]);
    expect(onlyOneQualifies.totalMatches).toBe(1);

    const nobodyQualifies = matchAnonymousCv("Rust developer.", [posting({ title: "Marketing Lead", description: "No overlap here." })], {
      threshold: 5,
    });
    expect(nobodyQualifies.poolTooSmall).toBe(true);
    expect(nobodyQualifies.totalMatches).toBe(0);
  });

  it("shows exactly two cards but reports the full qualifying count when more exist", () => {
    const result = matchAnonymousCv(
      "Rust and Docker developer.",
      [
        posting({ title: "Rust Engineer", description: "We also use Docker containers daily." }), // 16 + 7 = 23
        posting({ title: "Docker Specialist", description: "Familiar with Rust is a plus." }), // 14 + 8 = 22
        posting({ title: "Platform Engineer", description: "Some Rust and Docker experience helpful." }), // 8 + 7 = 15
      ],
      { threshold: 10 },
    );

    expect(result.poolTooSmall).toBe(false);
    expect(result.totalMatches).toBe(3);
    expect(result.matches).toHaveLength(2);
    expect(result.matches.map((m) => m.title)).toEqual(["Rust Engineer", "Docker Specialist"]);
    expect(result.matches[0]!.relevanceScore).toBeGreaterThan(result.matches[1]!.relevanceScore);
  });

  it("breaks a score tie by ascending posting id, deterministically", () => {
    const later = posting({ id: 50, title: "Rust Engineer II" });
    const earlier = posting({ id: 10, title: "Rust Engineer I" });
    const result = matchAnonymousCv("Rust developer.", [later, earlier], { threshold: 5 });
    expect(result.matches.map((m) => m.title)).toEqual(["Rust Engineer I", "Rust Engineer II"]);
  });

  it("penalizes a posting that demands unsponsored US work authorization or a clearance", () => {
    const cv = "Kubernetes, AWS and DevOps engineer.";
    const withBlocker = matchAnonymousCv(
      cv,
      [
        posting({
          title: "DevOps Engineer",
          description: "We use Kubernetes and AWS heavily. US citizens only, no visa sponsorship.",
        }),
      ],
      { threshold: 20, minResultsToShow: 1 },
    );
    const withoutBlocker = matchAnonymousCv(
      cv,
      [posting({ title: "DevOps Engineer", description: "We use Kubernetes and AWS heavily." })],
      { threshold: 20, minResultsToShow: 1 },
    );

    expect(withoutBlocker.matches).toHaveLength(1); // 32 without the penalty, clears the threshold
    expect(withBlocker.matches).toHaveLength(0); // 32 - 15 = 17, falls back below the threshold
  });

  it("only penalizes a senior-titled posting when the CV shows no seniority signal itself", () => {
    const juniorCv = "Backend engineer skilled in Kubernetes and AWS.";
    const seniorCv = "Senior backend engineer, 6 years experience, skilled in Kubernetes and AWS.";
    const target = () => posting({ title: "Senior Kubernetes Engineer", description: "Kubernetes and AWS daily." });

    const asJunior = matchAnonymousCv(juniorCv, [target()], { threshold: 20, minResultsToShow: 1 });
    const asSenior = matchAnonymousCv(seniorCv, [target()], { threshold: 20, minResultsToShow: 1 });

    expect(asJunior.matches).toHaveLength(0); // 24 - 10 senior penalty = 14, below threshold
    expect(asSenior.matches).toHaveLength(1); // no penalty: 24, clears the threshold
  });

  it("returns only the fields safe to show an anonymous visitor - never a URL", () => {
    const result = matchAnonymousCv("Rust developer.", [posting({ title: "Rust Engineer" })], {
      threshold: 5,
      minResultsToShow: 1,
    });
    expect(Object.keys(result.matches[0]!).sort()).toEqual(
      ["company", "descriptionExcerpt", "location", "relevanceScore", "title", "workMode"].sort(),
    );
  });

  it("strips HTML and truncates the description on a word boundary", () => {
    const long = `<p><strong>About the role</strong></p><div>${"word ".repeat(60)}tail</div>`;
    const result = matchAnonymousCv("Rust developer.", [posting({ title: "Rust Engineer", description: long })], {
      threshold: 5,
      minResultsToShow: 1,
    });
    const card = result.matches[0]!;
    expect(card.descriptionExcerpt).not.toContain("<");
    expect(card.descriptionExcerpt.endsWith("…")).toBe(true);
    expect(card.descriptionExcerpt.length).toBeLessThan(long.length);
  });

  it("leaves a short description untouched", () => {
    const result = matchAnonymousCv("Rust developer.", [posting({ title: "Rust Engineer", description: "Short and sweet." })], {
      threshold: 5,
      minResultsToShow: 1,
    });
    expect(result.matches[0]!.descriptionExcerpt).toBe("Short and sweet.");
  });

  it("is deterministic - the same input always yields the same output", () => {
    const postings = [
      posting({ title: "Rust Engineer" }),
      posting({ title: "Backend Engineer", description: "Rust experience needed." }),
    ];
    const first = matchAnonymousCv("Rust developer.", postings, { threshold: 5 });
    const second = matchAnonymousCv("Rust developer.", postings, { threshold: 5 });
    expect(second).toEqual(first);
  });
});
