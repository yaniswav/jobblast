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

import { excerpt } from "./text-excerpt";

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

// Lot J1 (opening to all trades, not just tech/business-function CVs): a
// plain `\b` word boundary silently breaks around an accented letter. JS's
// `\b` only recognizes ASCII `[A-Za-z0-9_]` as "word" characters, so a
// position between a space and an accented letter counts as two *non-word*
// sides - no transition, no boundary, no match. Concretely, `/\bkin[ée]\b/i`
// matches "kine" but not "kiné", and `/\b[ée]lectricien\b/i` matches
// "electricien" but not "électricien" - confirmed empirically, not
// theoretical. Most of this lot's new rules are French trade terms that
// routinely start or end on an accented letter ("Électricien", "kiné",
// "embarqué", "sûreté"...), so a plain `\b` would silently fail on the
// correctly-accented spelling exactly the CVs it targets are likely to use.
// `bound()` wraps a pattern in lookaround boundaries built on a word-char
// class that also includes the accented Latin letters (and œ/Œ), so these
// rules match equally whether the CV is typed with or without accents.
// Existing rules above are untouched - same behavior, same `\b` - this only
// applies to new rules appended below.
const WORD_CHAR = "A-Za-z0-9_À-ÖØ-öø-ÿŒœ";
function bound(pattern: string): RegExp {
  return new RegExp(`(?<![${WORD_CHAR}])(?:${pattern})(?![${WORD_CHAR}])`, "i");
}

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

  // --- Lot J1: opening to all trades (France-first, all contract types) ---
  // The rules above skew entirely software/business-function, which matches
  // this app's original niche but leaves a nurse, a mason, a salesperson, a
  // cook or a forklift operator with almost no recognizable terms in their
  // own CV. These groups cover the major non-tech trades so `/try` and
  // multi-CV selection (resume-select.ts, which reuses extractCvProfile())
  // work for a French job seeker in any field, not just tech.

  // Santé (healthcare)
  { skill: "Infirmier/Nurse", regex: bound("infirmiers?|infirmi[èe]res?|nursing|nurse"), weight: 9 },
  { skill: "Aide-soignant(e)", regex: bound("aide[- ]soignante?s?"), weight: 8 },
  { skill: "Médecin", regex: bound("m[ée]decins?|physician"), weight: 8 },
  { skill: "Pharmacien(ne)", regex: bound("pharmaciens?|pharmacienne?s?|pharmacist"), weight: 8 },
  { skill: "Kinésithérapeute", regex: bound("kin[ée]sith[ée]rapeutes?|kin[ée]|physiotherapist"), weight: 8 },
  { skill: "Ambulancier(ère)", regex: bound("ambulanciers?|ambulanci[èe]res?"), weight: 7 },
  { skill: "Sage-femme", regex: bound("sage[- ]femmes?|midwife"), weight: 8 },
  { skill: "EHPAD", regex: bound("ehpad|maison de retraite"), weight: 6 },
  { skill: "Bloc opératoire", regex: bound("bloc op[ée]ratoire"), weight: 6 },
  { skill: "Dentiste", regex: bound("dentistes?|chirurgien[- ]dentiste"), weight: 7 },

  // BTP / artisanat (construction trades)
  { skill: "Maçon(nerie)", regex: bound("ma[çc]ons?|ma[çc]onnerie"), weight: 8 },
  { skill: "Électricien(ne)", regex: bound("[ée]lectriciens?|[ée]lectricienne?s?"), weight: 8 },
  { skill: "Plombier", regex: bound("plombiers?|plomberie"), weight: 8 },
  { skill: "Chauffagiste", regex: bound("chauffagistes?"), weight: 7 },
  { skill: "Menuisier(ère)", regex: bound("menuisiers?|menuisi[èe]res?|menuiserie"), weight: 8 },
  // Bare "peintre" is ambiguous with a fine-art/creative painter - scoped to
  // the building-trade phrasing only.
  { skill: "Peintre en bâtiment", regex: bound("peintres? en b[âa]timent"), weight: 7 },
  { skill: "Conducteur de travaux", regex: bound("conducteurs? de travaux|chefs? de chantier"), weight: 8 },
  { skill: "Gros œuvre", regex: bound("gros[ -]?(?:œuvre|oeuvre)"), weight: 6 },
  { skill: "Couvreur", regex: bound("couvreurs?"), weight: 7 },
  { skill: "Carreleur", regex: bound("carreleurs?"), weight: 6 },
  { skill: "Charpentier", regex: bound("charpentiers?|charpente"), weight: 7 },
  { skill: "BTP", regex: bound("btp"), weight: 6 },

  // Vente / commerce
  { skill: "Vendeur/Vendeuse", regex: bound("vendeurs?|vendeuses?|retail sales|sales associate"), weight: 7 },
  { skill: "Commercial (vente)", regex: bound("commercial(?:e)?s?|technico[- ]commercial"), weight: 6 },
  {
    skill: "Conseiller clientèle",
    regex: bound(
      "conseillers? (?:de )?client[èe]le|conseill[èe]res? (?:de )?client[èe]le|charg[ée]s? de client[èe]le|customer advisor",
    ),
    weight: 7,
  },
  { skill: "Caissier(ère)", regex: bound("caissiers?|caissi[èe]res?|h[ôo]tesse de caisse"), weight: 6 },
  { skill: "Merchandising", regex: bound("merchandising"), weight: 6 },
  { skill: "Négociation commerciale", regex: bound("n[ée]gociation commerciale|n[ée]gociation client"), weight: 6 },
  { skill: "B2B/B2C", regex: bound("b2b|b2c"), weight: 5 },
  { skill: "Grande distribution", regex: bound("grande distribution"), weight: 6 },

  // Hôtellerie-restauration
  { skill: "Cuisinier(ère)", regex: bound("cuisiniers?|cuisini[èe]res?|commis de cuisine"), weight: 9 },
  { skill: "Chef de cuisine", regex: bound("chefs? de cuisine|executive chef"), weight: 8 },
  { skill: "Chef de partie", regex: bound("chefs? de partie"), weight: 8 },
  // Bare "serveur" collides with the tech sense of "server" (a French CV
  // says "administrateur serveur" too) - scoped to the restaurant/salle
  // phrasing, plus the unambiguous feminine "serveuse".
  {
    skill: "Serveur/Serveuse (salle)",
    regex: bound("serveurs? (?:en salle|de restaurant)|serveuses?|commis de salle|waiter|waitress"),
    weight: 8,
  },
  { skill: "Réceptionniste", regex: bound("r[ée]ceptionnistes?|front desk"), weight: 7 },
  { skill: "Barman/Barmaid", regex: bound("barmans?|barmaids?|bartenders?"), weight: 7 },
  { skill: "HACCP", regex: bound("haccp"), weight: 6 },
  { skill: "Hôtellerie-restauration", regex: bound("h[ôo]tellerie[- ]restauration|restauration collective"), weight: 6 },

  // Logistique / transport
  { skill: "Cariste", regex: bound("caristes?|chariots? [ée]l[ée]vateurs?"), weight: 8 },
  {
    skill: "Préparateur de commandes",
    regex: bound("pr[ée]parateurs? de commandes?|pr[ée]paratrices? de commandes?"),
    weight: 8,
  },
  { skill: "Chauffeur PL/SPL", regex: bound("chauffeurs? (?:pl|spl|poids lourds?)|truck driver"), weight: 8 },
  { skill: "CACES", regex: bound("caces"), weight: 7 },
  { skill: "Magasinier(ère)", regex: bound("magasiniers?|magasini[èe]res?"), weight: 7 },
  { skill: "Supply chain", regex: bound("supply chain|cha[îi]ne d'approvisionnement"), weight: 7 },
  { skill: "Livreur", regex: bound("livreurs?|chauffeur[- ]livreur|delivery driver"), weight: 6 },
  { skill: "Logistique", regex: bound("logistiques?"), weight: 6 },
  { skill: "Entrepôt", regex: bound("entrep[ôo]ts?|warehouse"), weight: 6 },

  // Admin / compta / finance
  { skill: "Comptable", regex: bound("comptables?"), weight: 8 },
  { skill: "Gestion de la paie", regex: bound("gestion(?:naire)?s? de (?:la )?paie|payroll"), weight: 7 },
  {
    skill: "Assistant(e) administratif(ve)",
    regex: bound("assistants? administratifs?|assistantes? administratives?"),
    weight: 7,
  },
  { skill: "Facturation", regex: bound("facturation|billing"), weight: 6 },
  { skill: "Contrôle de gestion", regex: bound("contr[ôo]le de gestion|contr[ôo]leurs? de gestion"), weight: 7 },
  { skill: "Audit", regex: bound("audits?|auditeurs?|auditrices?|auditors?"), weight: 7 },
  { skill: "Trésorerie", regex: bound("tr[ée]sorerie"), weight: 6 },
  { skill: "Fiscalité", regex: bound("fiscalit[ée]|fiscalistes?"), weight: 6 },

  // Éducation / social
  { skill: "Enseignant(e)", regex: bound("enseignants?|enseignantes?|teacher"), weight: 8 },
  { skill: "Formateur/trice", regex: bound("formateurs?|formatrices?|trainer"), weight: 7 },
  {
    skill: "Éducateur spécialisé",
    regex: bound("[ée]ducateurs? sp[ée]cialis[ée]s?|[ée]ducatrices? sp[ée]cialis[ée]es?"),
    weight: 8,
  },
  {
    skill: "Petite enfance",
    regex: bound("petite enfance|auxiliaire de pu[ée]riculture|[ée]ducateurs? de jeunes enfants"),
    weight: 7,
  },
  { skill: "Auxiliaire de vie", regex: bound("auxiliaires? de vie|home care aide"), weight: 7 },
  // Bare "animateur" collides with a 3D/motion-graphics animator - scoped to
  // the socio-educational phrasing plus the unambiguous BAFA certification.
  {
    skill: "Animation socioculturelle",
    regex: bound(
      "animateurs? (?:socioculturels?|p[ée]riscolaires?|jeunesse)|animatrices? (?:socioculturelles?|p[ée]riscolaires?)|bafa",
    ),
    weight: 7,
  },
  { skill: "AESH", regex: bound("aesh"), weight: 6 },

  // RH / juridique
  { skill: "Gestionnaire RH", regex: bound("gestionnaires? (?:rh|ressources humaines)|hr generalist"), weight: 7 },
  { skill: "Juriste", regex: bound("juristes?"), weight: 7 },
  { skill: "Paralegal", regex: bound("paralegals?"), weight: 6 },
  { skill: "Droit social/du travail", regex: bound("droit (?:social|du travail)|employment law"), weight: 6 },
  // Bare "avocat" is the French word for "avocado" - scoped to the
  // profession-specific phrasing to avoid matching a cuisine/nutrition CV.
  {
    skill: "Avocat(e)",
    regex: bound("avocats? au barreau|avocates? au barreau|cabinet d'avocats?|lawyer|attorney"),
    weight: 7,
  },
  { skill: "Contentieux", regex: bound("contentieux"), weight: 6 },

  // Marketing / com
  { skill: "Community management", regex: bound("community manager|community management"), weight: 7 },
  // Bare "SEA" (a common acquisition-marketing acronym) is also the English
  // word "sea" - dropped in favor of "SEO" (safe, not an English word) and
  // the spelled-out phrases.
  {
    skill: "SEO",
    regex: bound("seo|search engine optimization|search engine advertising|r[ée]f[ée]rencement naturel"),
    weight: 7,
  },
  {
    skill: "Rédaction de contenu",
    regex: bound(
      "r[ée]dacteurs? (?:web|de contenu)|r[ée]dactrices? (?:web|de contenu)|content writer|copywriter|copywriting",
    ),
    weight: 7,
  },
  { skill: "Graphiste", regex: bound("graphistes?|graphic designer"), weight: 7 },
  { skill: "Chargé(e) de communication", regex: bound("charg[ée]s? de communication|communications officer"), weight: 7 },
  { skill: "Réseaux sociaux", regex: bound("r[ée]seaux sociaux|social media"), weight: 6 },

  // Industrie / production
  {
    skill: "Opérateur de production",
    regex: bound("op[ée]rateurs? de production|op[ée]ratrices? de production|production operator"),
    weight: 7,
  },
  { skill: "Usinage", regex: bound("usinage|usineurs?|machining"), weight: 7 },
  { skill: "Soudeur(euse)", regex: bound("soudeurs?|soudeuses?|welder"), weight: 8 },
  {
    skill: "Maintenance industrielle",
    regex: bound("maintenance industrielle|techniciens? de maintenance|industrial maintenance"),
    weight: 8,
  },
  {
    skill: "Contrôle qualité industriel",
    regex: bound("contr[ôo]le qualit[ée]|assurance qualit[ée]|quality control"),
    weight: 6,
  },
  { skill: "Conducteur de ligne", regex: bound("conducteurs? de ligne|r[ée]gleurs?|commande num[ée]rique"), weight: 6 },
  {
    skill: "Méthodes industrielles",
    regex: bound("m[ée]thodes industrielles|industrialisation|techniciens? m[ée]thodes"),
    weight: 6,
  },

  // Sécurité / nettoyage / services
  { skill: "Agent de sécurité", regex: bound("agents? de s[ée]curit[ée]|security guard"), weight: 8 },
  { skill: "SSIAP", regex: bound("ssiap"), weight: 7 },
  // Bare "entretien" is also the French word for a job interview - scoped to
  // "agent d'entretien"/"agent de nettoyage".
  { skill: "Agent d'entretien", regex: bound("agents? d'entretien|agents? de nettoyage|cleaning agent"), weight: 7 },
  // Bare "gardien" is also a sports goalkeeper ("gardien de but") - scoped
  // to the building-caretaker sense.
  {
    skill: "Gardien(ne) d'immeuble",
    regex: bound("gardiens? d'immeuble|gardiennes? d'immeuble|concierge"),
    weight: 6,
  },
  { skill: "Sûreté/vidéosurveillance", regex: bound("vid[ée]osurveillance|s[ûu]ret[ée]"), weight: 6 },
  { skill: "Agent de ménage", regex: bound("agents? de m[ée]nage|femmes? de m[ée]nage|housekeeping"), weight: 6 },

  // Immobilier
  { skill: "Agent immobilier", regex: bound("agents? immobiliers?|real estate agent"), weight: 8 },
  {
    skill: "Négociateur immobilier",
    regex: bound("n[ée]gociateurs? immobiliers?|n[ée]gociatrices? immobili[èe]res?"),
    weight: 7,
  },
  { skill: "Gestion locative/Syndic", regex: bound("gestion locative|syndic(?: de copropri[ée]t[ée])?"), weight: 6 },
  { skill: "Property management", regex: bound("property management|property manager"), weight: 6 },

  // Banque / assurance
  { skill: "Conseiller(ère) bancaire", regex: bound("conseillers? bancaires?|conseill[èe]res? bancaires?|bank advisor"), weight: 7 },
  {
    skill: "Gestionnaire de sinistres",
    regex: bound("gestionnaires? (?:de )?sinistres?|claims handler|claims adjuster"),
    weight: 7,
  },
  { skill: "Souscripteur", regex: bound("souscripteurs?|souscriptrices?|underwriters?"), weight: 6 },
  { skill: "Courtier(ère)", regex: bound("courtiers?|courti[èe]res?|broker"), weight: 6 },
  { skill: "Actuaire", regex: bound("actuaires?|actuary|actuaries"), weight: 6 },
  { skill: "Banque de détail", regex: bound("banque de d[ée]tail|retail banking"), weight: 5 },

  // Agriculture / paysage
  { skill: "Agriculteur(trice)", regex: bound("agriculteurs?|agricultrices?|exploitants? agricoles?|farmer"), weight: 7 },
  { skill: "Ouvrier agricole", regex: bound("ouvriers? agricoles?|agricultural worker"), weight: 6 },
  { skill: "Paysagiste", regex: bound("paysagistes?|landscaper"), weight: 7 },
  { skill: "Élevage", regex: bound("[ée]levage|livestock"), weight: 6 },
  { skill: "Viticulture", regex: bound("viticulture|viticoles?|vignerons?|vigneronnes?"), weight: 6 },
  { skill: "Maraîchage/Horticulture", regex: bound("mara[îi]chage|horticulture"), weight: 6 },
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

function toCard(entry: ScoredPosting): AnonymousMatchCard {
  return {
    title: entry.posting.title,
    company: entry.posting.company,
    location: entry.posting.location,
    workMode: entry.posting.workMode,
    relevanceScore: entry.score,
    descriptionExcerpt: excerpt(entry.posting.description, DESCRIPTION_EXCERPT_LENGTH),
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
