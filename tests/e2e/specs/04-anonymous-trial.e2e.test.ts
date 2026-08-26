// The anonymous CV-to-postings trial (lot H1): a visitor with no account
// pastes a CV and gets a taste of the shared pool before the invite-only
// signup wall. This spec only asserts what the endpoint guarantees
// deterministically - response shape, and that a match never leaks an
// application URL or a posting id - never that a specific posting is
// returned, since the pool's contents at any given moment depend on
// whatever earlier specs or prior runs against this same long-lived stack
// have fetched (docs/SAAS-ARCHITECTURE.md section 3.2).

import { describe, expect, it } from "vitest";
import { newSession, post } from "../lib/client";

type AnonymousMatchCard = {
  title: string;
  company: string;
  location: string;
  workMode: string;
  relevanceScore: number;
  descriptionExcerpt: string;
};
type AnonymousMatchResult = { matches: AnonymousMatchCard[]; totalMatches: number; poolTooSmall: boolean };

const MATCH_CARD_KEYS = ["company", "descriptionExcerpt", "location", "relevanceScore", "title", "workMode"].sort();

// Broad on purpose - a fair shot at matching whatever real postings this
// stack has already fetched, across a wide mix of engineering and adjacent
// business functions (lib/anonymous-match.ts's keyword list).
const FAKE_CV = `
Jordan Doe - Software Engineer (e2e anonymous-trial fixture)
8 years of experience building full-stack products end to end.
Skills: TypeScript, JavaScript, React, Node.js, Python, AWS, Docker, Kubernetes,
PostgreSQL, GraphQL, DevOps, backend, frontend, product management.
Led cross-functional teams and shipped customer-facing features.
`;

describe("anonymous trial: CV-to-postings matching with no account", () => {
  // Exactly two POST /trial/match calls in this whole file - both count
  // against the server's per-IP daily budget (5/day, routes/trial.ts),
  // shared across however many times this suite runs against the same
  // long-lived stack on one day. Keep it at exactly these two; if the budget
  // is exhausted mid-development, restart the app container to reset the
  // in-memory limiter (docs/DOCKER.md's "restart app"), same as the auth
  // rate limiters.
  it("matches a pasted CV against the shared pool without ever leaking an application URL or posting id", async () => {
    const session = newSession();
    const res = await post<AnonymousMatchResult>(session, "/trial/match", { cvText: FAKE_CV });

    expect(res.status).toBe(200);
    expect(typeof res.data.totalMatches).toBe("number");
    expect(res.data.totalMatches).toBeGreaterThanOrEqual(0);
    expect(typeof res.data.poolTooSmall).toBe("boolean");
    expect(Array.isArray(res.data.matches)).toBe(true);
    expect(res.data.matches.length).toBeLessThanOrEqual(2);
    // The honest-fallback and "here are real matches" cases are mutually
    // exclusive - see lib/anonymous-match.ts's matchAnonymousCv.
    expect(res.data.poolTooSmall).toBe(res.data.matches.length === 0);

    for (const match of res.data.matches) {
      // No `url`, no `id`: exactly the fields lib/anonymous-match.ts's
      // AnonymousMatchCard declares, nothing more - the application URL
      // stays a reason to create an account.
      expect(Object.keys(match).sort()).toEqual(MATCH_CARD_KEYS);
      expect(typeof match.title).toBe("string");
      expect(typeof match.company).toBe("string");
      expect(typeof match.relevanceScore).toBe("number");
      expect(typeof match.descriptionExcerpt).toBe("string");
    }

    // A public, unauthenticated path: no session cookie is ever set.
    expect(session.cookie).toBeNull();
  });

  it("rejects a CV with unreadably little text as 400, not a match attempt", async () => {
    const res = await post<{ error: string }>(newSession(), "/trial/match", { cvText: "hi" });
    expect(res.status).toBe(400);
    expect(typeof res.data.error).toBe("string");
  });
});
