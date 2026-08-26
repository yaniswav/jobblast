// Deterministic CV-to-postings matching for the anonymous trial funnel (lot
// H1, docs/SAAS-ARCHITECTURE.md, routes/trial.ts): a visitor with no account
// pastes or uploads a CV and gets a taste of the shared postings pool before
// hitting the invite-only signup wall.
//
// Pure logic, no database, no AI, no per-account config: unlike
// lib/sources/scoring.ts (which reads its keyword rules from
// `jobblast.config.json` / `user_settings.config`), there is no account yet
// to own a configuration, and `loadConfig()` throws with no ambient user
// context in `saas` anyway (docs/SAAS-ARCHITECTURE.md section 4). So this
// module hardcodes its own static, deliberately generic rule list, shaped
// the same way scoring.ts's is (weighted regex per skill, a title hit worth
// double a description hit) but broadened from one person's C++/embedded
// niche to the vocabulary a stranger's CV is actually likely to contain,
// given the kind of postings this app aggregates (see lib/sources/*.ts):
// mostly software engineering, plus the product/design/marketing/ops
// functions that show up on the same Greenhouse/Lever company boards.
//
// Known limitation, deliberate: with no profile at all there is no target
// location and no declared seniority, so this cannot reuse scoring.ts's
// location bonus or its `usLocation`/`offsiteNonTarget` penalties (both need
// a location to compare against). Two of scoring.ts's penalties *do*
// generalize without a profile and are kept, adapted: a posting demanding US
// citizenship/security clearance is a poor match for most anonymous visitors
// of a public demo, and "senior/staff/lead" is only a poor match when the
// CV itself carries no seniority signal - see `hasSeniorSignal` below.

export type PostingLike = {
  id: number;
  title: string;
  company: string;
  location: string;
  workMode: string;
  description: string;
};

export type AnonymousMatchCard = {
  title: string;
  company: string;
  location: string;
  workMode: string;
  relevanceScore: number;
  descriptionExcerpt: string;
};

export type AnonymousMatchResult = {
  matches: AnonymousMatchCard[];
  /**
   * How many postings in the scanned slice of the pool cleared the
   * threshold - including the ones returned in `matches`. Bounded by
   * whatever slice of the pool the caller passed in (routes/trial.ts scans
   * the `ANONYMOUS_POOL_SCAN_LIMIT` most recently seen postings, not the
   * entire historical pool), so this is "at least this many", not a claim
   * about the whole platform.
   */
  totalMatches: number;
  /**
   * True when there were not enough good matches to show two honest cards -
   * the caller should show "the pool is still starting" rather than force
   * weak, irrelevant results. See docs/SAAS-ARCHITECTURE.md's H1 brief,
   * "cas pool vide/pauvre".
   */
  poolTooSmall: boolean;
};

/** A minimum CV text length below which matching is not worth attempting. */
export const CV_TEXT_MIN_LENGTH = 30;
/** Upper bound on pasted CV text, mirrors the brief's ~50KB cap. */
export const CV_TEXT_MAX_LENGTH = 50_000;
/** How many of the most-recently-seen pool postings a trial request scans. */
export const ANONYMOUS_POOL_SCAN_LIMIT = 500;
/** A posting needs at least this weighted score to count as a real match. */
export const ANONYMOUS_MATCH_THRESHOLD = 20;
/** Below this many qualifying matches, show the honest fallback instead. */
export const ANONYMOUS_MIN_RESULTS_TO_SHOW = 2;
/** How many cards the trial ever shows. */
export const ANONYMOUS_TOP_RESULTS = 2;
/** Scores are clamped to this ceiling, same spirit as scoring.ts's scoreCap. */
const ANONYMOUS_SCORE_CAP = 100;
const DESCRIPTION_EXCERPT_LENGTH = 220;

type KeywordRule = { skill: string; regex: RegExp; weight: number };

// Generalized from lib/sources/scoring.ts's default (jobblast.config.example.json's
// `scoring.rules`), which is tuned to one person's C++/embedded/DDS profile.
// Nothing here is copied verbatim from that personal config - this is a
// fresh, broad list covering the software engineering disciplines and
// adjacent business functions (product, design, marketing, sales, ops, HR)
// that actually appear across the boards lib/sources/* aggregates. A handful
// of entries carry an obvious French synonym since France Travail/Adzuna
// postings are French.
const KEYWORD_RULES: KeywordRule[] = [
  // Core languages
  { skill: "JavaScript", regex: /\bjavascript\b/i, weight: 8 },
  { skill: "TypeScript", regex: /\btypescript\b/i, weight: 9 },
  { skill: "Python", regex: /\bpython\b/i, weight: 9 },
  { skill: "Java", regex: /\bjava\b/i, weight: 8 },
  { skill: "C++", regex: /\bc\+\+/i, weight: 9 },
  { skill: "C#", regex: /\bc#/i, weight: 8 },
  { skill: "Go", regex: /\bgolang\b/i, weight: 8 },
  { skill: "Rust", regex: /\brust\b/i, weight: 8 },
  { skill: "PHP", regex: /\bphp\b/i, weight: 7 },
  { skill: "Ruby", regex: /\bruby\b/i, weight: 7 },
  { skill: "Swift", regex: /\bswift\b/i, weight: 8 },
  { skill: "Kotlin", regex: /\bkotlin\b/i, weight: 8 },
  { skill: "SQL", regex: /\bsql\b/i, weight: 7 },

  // Frameworks / platforms
  { skill: "React", regex: /\breact(\.js)?\b/i, weight: 8 },
  { skill: "Angular", regex: /\bangular\b/i, weight: 8 },
  { skill: "Vue", regex: /\bvue(\.js)?\b/i, weight: 8 },
  { skill: "Node.js", regex: /\bnode(\.js)?\b/i, weight: 8 },
  { skill: "Django", regex: /\bdjango\b/i, weight: 7 },
  { skill: "Spring", regex: /\bspring\b/i, weight: 6 },
  { skill: ".NET", regex: /\.net\b/i, weight: 7 },
  { skill: "GraphQL", regex: /\bgraphql\b/i, weight: 7 },
  { skill: "REST API", regex: /\brest(ful)?\s?api\b/i, weight: 6 },

  // Data / AI
  { skill: "Machine learning", regex: /\bmachine learning\b/i, weight: 9 },
  { skill: "Data science", regex: /\bdata science\b/i, weight: 9 },
  { skill: "Data engineering", regex: /\bdata engineer(ing)?\b/i, weight: 9 },
  { skill: "Data analysis", regex: /\bdata analy(st|sis|tics)\b/i, weight: 8 },
  { skill: "PostgreSQL/MySQL", regex: /\b(postgresql|postgres|mysql)\b/i, weight: 6 },
  { skill: "MongoDB/NoSQL", regex: /\b(mongodb|nosql)\b/i, weight: 6 },
  { skill: "Deep learning", regex: /\bdeep learning\b/i, weight: 8 },
  { skill: "NLP/LLM", regex: /\b(nlp|natural language processing|llm|large language model)\b/i, weight: 8 },
  { skill: "Computer vision", regex: /\bcomputer vision\b/i, weight: 8 },
  { skill: "ETL", regex: /\betl\b/i, weight: 6 },

  // Infra / cloud
  { skill: "AWS", regex: /\baws\b|\bamazon web services\b/i, weight: 8 },
  { skill: "Azure", regex: /\bazure\b/i, weight: 8 },
  { skill: "GCP", regex: /\bgcp\b|\bgoogle cloud\b/i, weight: 8 },
  { skill: "Docker", regex: /\bdocker\b/i, weight: 7 },
  { skill: "Kubernetes", regex: /\bkubernetes\b|\bk8s\b/i, weight: 8 },
  { skill: "DevOps", regex: /\bdevops\b/i, weight: 8 },
  { skill: "CI/CD", regex: /\bci\/cd\b|\bcontinuous integration\b/i, weight: 6 },
  { skill: "Terraform", regex: /\bterraform\b/i, weight: 7 },
  { skill: "Linux", regex: /\blinux\b/i, weight: 6 },
  { skill: "Site reliability", regex: /\bsite reliability\b|\bsre\b/i, weight: 8 },
  { skill: "Cybersecurity", regex: /\bcyber ?security\b|\binfosec\b/i, weight: 8 },

  // Mobile
  { skill: "iOS", regex: /\bios\b/i, weight: 8 },
  { skill: "Android", regex: /\bandroid\b/i, weight: 8 },
  { skill: "React Native", regex: /\breact native\b/i, weight: 8 },
  { skill: "Flutter", regex: /\bflutter\b/i, weight: 8 },

  // Engineering roles / domains
  { skill: "Frontend", regex: /\bfront[- ]?end\b/i, weight: 9 },
  { skill: "Backend", regex: /\bback[- ]?end\b/i, weight: 9 },
  { skill: "Full-stack", regex: /\bfull[- ]?stack\b/i, weight: 9 },
  { skill: "Embedded systems", regex: /\b(embedded|firmware|embarqu[ée]s?)\b/i, weight: 9 },
  { skill: "QA/testing", regex: /\b(qa|quality assurance|test automation)\b/i, weight: 7 },
  { skill: "Technical writing", regex: /\btechnical writ(er|ing)\b/i, weight: 6 },

  // Product / design
  { skill: "Product management", regex: /\bproduct manager\b|\bproduct management\b|\bchef de produit\b/i, weight: 9 },
  { skill: "Product owner", regex: /\bproduct owner\b/i, weight: 8 },
  { skill: "UX/UI design", regex: /\b(ux|ui|user experience|user interface)\b/i, weight: 8 },
  { skill: "User research", regex: /\buser research\b/i, weight: 7 },

  // Business / go-to-market
  { skill: "Marketing", regex: /\bmarketing\b/i, weight: 7 },
  { skill: "Growth", regex: /\bgrowth\b/i, weight: 6 },
  { skill: "Sales", regex: /\bsales\b|\bventes\b/i, weight: 7 },
  { skill: "Business development", regex: /\bbusiness development\b/i, weight: 7 },
  { skill: "Account management", regex: /\baccount (manager|management|director)\b/i, weight: 7 },
  { skill: "Customer success", regex: /\bcustomer success\b/i, weight: 7 },
  { skill: "Customer support", regex: /\bcustomer (support|service)\b|\bsupport client\b/i, weight: 6 },
  { skill: "Go-to-market", regex: /\bgo[- ]to[- ]market\b|\bgtm\b/i, weight: 6 },

  // People / operations
  { skill: "Human resources", regex: /\bhuman resources\b|\bhr business partner\b|\bressources humaines\b/i, weight: 6 },
  { skill: "Recruiting", regex: /\brecruit(ing|er|ment)\b/i, weight: 6 },
  { skill: "Operations", regex: /\boperations\b/i, weight: 6 },
  { skill: "Finance/accounting", regex: /\b(finance|accounting|comptabilit[ée])\b/i, weight: 6 },
  { skill: "Legal", regex: /\blegal\b/i, weight: 6 },
  { skill: "Executive assistant", regex: /\bexecutive assistant\b/i, weight: 5 },

  // Methodology
  { skill: "Agile/Scrum", regex: /\b(agile|scrum)\b/i, weight: 5 },
  { skill: "Project management", regex: /\bproject management\b|\bgestion de projet\b/i, weight: 6 },
];

// Adapted from scoring.ts's `penalties.workAuthorization` pattern (the
// pattern shape is reused; the weight is not - that config's -40 is tuned to
// one account's own risk tolerance, not a sane default for an anonymous
// global audience). A posting insisting on unsponsored US work
// authorization or a security clearance is a weak match for most visitors of
// a public trial with no declared nationality.
const WORK_AUTHORIZATION_BLOCKER =
  /u\.?s\.?\s+citizens?|green\s?card|\bw-?2\b|authorized to work in the (?:u\.?s\.?a?\.?|united states)|us work authorization|(?:unable|not able) to sponsor|no (?:visa |new )?(?:visa )?sponsorship|h-?1b (?:transfer|holders?)|security clearance|\bts\/sci\b|\bus persons?\b/i;
const WORK_AUTHORIZATION_PENALTY = 15;

// Adapted from scoring.ts's `penalties.seniorTitle`, but judgment-gated on
// the CV itself instead of a stored profile: with no account, the only
// signal available for "does this candidate look senior" is the CV text.
const SENIOR_TITLE_PATTERN = /\b(senior|staff|principal|lead|director)\b/i;
const SENIOR_TITLE_PENALTY = 10;

// Reused from scoring.ts's `penalties.seniorYears` pattern - not applied as
// a penalty here (there is no "junior" default to protect), but as the
// signal that gates SENIOR_TITLE_PATTERN above: a CV that already reads as
// senior should not be penalized for matching a senior posting.
const YEARS_EXPERIENCE_SIGNAL =
  /\b(?:[5-9]|1[0-9])\s*(?:\+|to \d+|-\d+)?\s*(?:years?|yrs?|ans)\b.{0,50}(?:experience|expérience)|(?:experience|expérience)\D{0,30}\b(?:[5-9]|1[0-9])\s*\+?\s*(?:years?|yrs?|ans)\b/i;
const SENIOR_ROLE_SIGNAL = /\b(senior|staff|principal|lead|head of|director|vp|chief)\b/i;

function hasSeniorSignal(cvText: string): boolean {
  return SENIOR_ROLE_SIGNAL.test(cvText) || YEARS_EXPERIENCE_SIGNAL.test(cvText);
}

export type CvProfile = {
  /** Skill labels (from KEYWORD_RULES) detected anywhere in the CV text. */
  skills: Set<string>;
  /** Whether the CV itself carries a seniority signal (see hasSeniorSignal). */
  seniorSignal: boolean;
};

/** Which of the static keyword rules the CV text hits, plus its seniority signal. */
export function extractCvProfile(cvText: string): CvProfile {
  const skills = new Set<string>();
  for (const rule of KEYWORD_RULES) {
    if (rule.regex.test(cvText)) skills.add(rule.skill);
  }
  return { skills, seniorSignal: hasSeniorSignal(cvText) };
}

type ScoredPosting = {
  posting: PostingLike;
  score: number;
};

/**
 * Weighted overlap between what the CV shows and one posting: title hits
 * count double a description hit (same idea as scoring.ts), only over the
 * skills the CV itself matched - a posting cannot score on a skill the CV
 * never mentioned.
 */
function scorePostingForCv(profile: CvProfile, posting: PostingLike): ScoredPosting {
  let score = 0;

  for (const rule of KEYWORD_RULES) {
    if (!profile.skills.has(rule.skill)) continue;
    const inTitle = rule.regex.test(posting.title);
    const inDescription = rule.regex.test(posting.description);
    if (!inTitle && !inDescription) continue;
    score += inTitle ? rule.weight * 2 : rule.weight;
  }

  if (WORK_AUTHORIZATION_BLOCKER.test(`${posting.title}\n${posting.description}`)) {
    score -= WORK_AUTHORIZATION_PENALTY;
  }
  if (!profile.seniorSignal && SENIOR_TITLE_PATTERN.test(posting.title)) {
    score -= SENIOR_TITLE_PENALTY;
  }

  return { posting, score: Math.max(0, Math.min(ANONYMOUS_SCORE_CAP, score)) };
}

/** Collapses whitespace/HTML and truncates on a word boundary for the trial card. */
function excerpt(description: string): string {
  const plain = description.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  if (plain.length <= DESCRIPTION_EXCERPT_LENGTH) return plain;
  const cut = plain.slice(0, DESCRIPTION_EXCERPT_LENGTH);
  const lastSpace = cut.lastIndexOf(" ");
  const boundary = lastSpace > 40 ? lastSpace : DESCRIPTION_EXCERPT_LENGTH;
  return `${cut.slice(0, boundary).trimEnd()}…`;
}

function toCard(entry: ScoredPosting): AnonymousMatchCard {
  return {
    title: entry.posting.title,
    company: entry.posting.company,
    location: entry.posting.location,
    workMode: entry.posting.workMode,
    relevanceScore: entry.score,
    descriptionExcerpt: excerpt(entry.posting.description),
  };
}

/**
 * Scores `postings` against `cvText` and returns the top matches, honestly:
 * when fewer than `minResultsToShow` postings clear `threshold`, `matches`
 * is empty and `poolTooSmall` is true instead of forcing weak results onto
 * the card. Pure - no I/O, no randomness, same input always yields the same
 * output (ties break on posting id, ascending, for a stable order).
 */
export function matchAnonymousCv(
  cvText: string,
  postings: PostingLike[],
  options: { threshold?: number; minResultsToShow?: number; topN?: number } = {},
): AnonymousMatchResult {
  const threshold = options.threshold ?? ANONYMOUS_MATCH_THRESHOLD;
  const minResultsToShow = options.minResultsToShow ?? ANONYMOUS_MIN_RESULTS_TO_SHOW;
  const topN = options.topN ?? ANONYMOUS_TOP_RESULTS;

  const profile = extractCvProfile(cvText);
  const qualifying = postings
    .map((posting) => scorePostingForCv(profile, posting))
    .filter((entry) => entry.score >= threshold)
    .sort((a, b) => b.score - a.score || a.posting.id - b.posting.id);

  if (qualifying.length < minResultsToShow) {
    return { matches: [], totalMatches: qualifying.length, poolTooSmall: true };
  }

  return {
    matches: qualifying.slice(0, topN).map(toCard),
    totalMatches: qualifying.length,
    poolTooSmall: false,
  };
}
