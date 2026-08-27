// Smart-search vocabularies and pure helpers (lot H6): static, local,
// deterministic autocomplete for the tag inputs across the app (profile
// targeting, onboarding/Settings search criteria) - zero network, zero AI,
// same idea as lib/sources/ats/catalog-search.ts's foldForSearch on the
// server, but this module is the browser-side twin since these dropdowns
// filter entirely client-side against a static list.
//
// Nothing here talks to the backend. A user typing free text that matches
// nothing in these lists behaves exactly as before this lot: the dropdown
// just stays empty and the raw text is still addable.

/** Strips diacritics and lowercases, so "é"/"e" and "Thalès"/"thales" compare equal. */
export function fold(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '') // combining diacritical marks left behind by NFD
    .toLowerCase()
    .trim();
}

/**
 * Folds further by dropping every whitespace character, so "C++", "c++" and
 * "c ++" all collapse to the same dedup key. Comparison-only - never used to
 * decide what gets stored or displayed.
 */
function foldForDedup(value: string): string {
  return fold(value).replace(/\s+/g, '');
}

/** Whether `candidate` already exists in `existing`, ignoring case, accents and whitespace. */
export function isDuplicateTag(existing: readonly string[], candidate: string): boolean {
  const key = foldForDedup(candidate);
  if (!key) return false;
  return existing.some((item) => foldForDedup(item) === key);
}

/** How many suggestions the dropdown ever shows at once. */
export const MAX_SUGGESTIONS = 8;

/**
 * Matches `query` against `pool` (case/accent-insensitive substring), drops
 * anything already present in `existing`, ranks a prefix match above a
 * mid-string match, then alphabetically, and caps at `limit`. Pure - same
 * ranking shape as catalog-search.ts's rank() on the server, applied here to
 * a flat list of strings instead of catalog entries.
 */
export function filterSuggestions(
  pool: readonly string[],
  query: string,
  existing: readonly string[] = [],
  limit: number = MAX_SUGGESTIONS,
): string[] {
  const folded = fold(query);
  if (!folded) return [];

  return pool
    .filter((item) => !isDuplicateTag(existing, item))
    .map((item) => ({ item, foldedItem: fold(item) }))
    .filter(({ foldedItem }) => foldedItem.includes(folded))
    .sort((a, b) => {
      const aRank = a.foldedItem.startsWith(folded) ? 0 : 1;
      const bRank = b.foldedItem.startsWith(folded) ? 0 : 1;
      return aRank - bRank || a.item.localeCompare(b.item);
    })
    .slice(0, limit)
    .map(({ item }) => item);
}

// ---------------------------------------------------------------------------
// Vocabularies
// ---------------------------------------------------------------------------

/**
 * Skill / keyword suggestions for search-criteria keywords (search-criteria-fields.tsx,
 * used by onboarding + Settings). Extracted and generalized from the skill
 * labels of artifacts/api-server/src/lib/anonymous-match.ts's KEYWORD_RULES
 * (the ~74 rules that drive the anonymous trial matcher) - that file stays
 * the single source of truth for actual matching logic; this is only a flat
 * list of strings for autocomplete, with combined labels split out
 * ("PostgreSQL/MySQL" -> "PostgreSQL", "MySQL") and a handful of common
 * French synonyms added, since this app's postings are bilingual (FR/EN).
 * A term typed here that isn't in this list still works exactly as before -
 * this only feeds the dropdown, never validates input.
 */
export const SKILL_SUGGESTIONS: string[] = [
  // Languages
  'JavaScript', 'TypeScript', 'Python', 'Java', 'C++', 'C', 'C#', 'Go', 'Rust', 'PHP', 'Ruby', 'Swift',
  'Kotlin', 'SQL', 'Scala', 'Perl', 'R', 'Bash', 'Shell scripting', 'MATLAB',
  // Frontend
  'React', 'React.js', 'Angular', 'Vue', 'Vue.js', 'Next.js', 'Nuxt', 'Svelte', 'HTML', 'CSS', 'Tailwind CSS',
  // Backend
  'Node.js', 'Express.js', 'Django', 'Flask', 'FastAPI', 'Spring', 'Spring Boot', '.NET', 'ASP.NET',
  'Laravel', 'Ruby on Rails', 'GraphQL', 'REST API', 'RESTful API', 'Microservices', 'API design',
  // Data / AI
  'Machine learning', 'Data science', 'Data engineering', 'Data analysis', 'Data analytics', 'PostgreSQL',
  'MySQL', 'MongoDB', 'NoSQL', 'Deep learning', 'NLP', 'LLM', 'Large language models', 'Computer vision',
  'ETL', 'Data pipeline', 'Business intelligence', 'Power BI', 'Tableau', 'Big data', 'Spark', 'Hadoop',
  'Airflow', 'Snowflake', 'dbt', 'Artificial intelligence',
  // Infra / cloud
  'AWS', 'Amazon Web Services', 'Azure', 'GCP', 'Google Cloud', 'Docker', 'Kubernetes', 'DevOps', 'CI/CD',
  'Continuous integration', 'Terraform', 'Linux', 'Site reliability engineering', 'SRE', 'Cybersecurity',
  'Infosec', 'Cloud infrastructure', 'Networking', 'Ansible', 'Jenkins', 'Observability', 'System administration',
  // Mobile
  'iOS', 'Android', 'React Native', 'Flutter', 'SwiftUI', 'Kotlin Multiplatform', 'Mobile development',
  // Engineering roles / domains
  'Frontend', 'Front-end', 'Backend', 'Back-end', 'Full-stack', 'Full-stack development', 'Embedded systems',
  'Firmware', 'QA', 'Quality assurance', 'Test automation', 'Technical writing', 'Software engineering',
  'Systems programming', 'Distributed systems', 'Solutions architecture', 'Software architecture',
  // Product / design
  'Product management', 'Product manager', 'Product owner', 'UX design', 'UI design', 'User experience',
  'User interface', 'User research', 'Product design', 'Design systems', 'Figma',
  // Business / go-to-market
  'Marketing', 'Digital marketing', 'Growth', 'Growth marketing', 'Sales', 'Business development',
  'Account management', 'Account executive', 'Customer success', 'Customer support', 'Customer service',
  'Go-to-market', 'Partnerships', 'Community management',
  // People / operations
  'Human resources', 'HR business partner', 'Recruiting', 'Talent acquisition', 'Operations', 'Finance',
  'Accounting', 'Legal', 'Executive assistant', 'Office management', 'Supply chain', 'Procurement',
  // Methodology
  'Agile', 'Scrum', 'Kanban', 'Project management', 'Program management', 'Lean',
  // French equivalents
  'Développeur', 'Développeuse', 'Développeur web', 'Développeur full-stack', 'Développeur back-end',
  'Développeur front-end', 'Développeur mobile', 'Développeur embarqué', 'Ingénieur logiciel',
  'Ingénieur informatique', 'Ingénieur data', 'Ingénieur DevOps', 'Ingénieur systèmes embarqués',
  'Architecte logiciel', 'Chef de projet', 'Gestion de projet', 'Chef de produit', 'Analyste de données',
  'Science des données', 'Intelligence artificielle', 'Apprentissage automatique', 'Vision par ordinateur',
  'Traitement du langage naturel', 'Comptabilité', 'Ressources humaines', 'Recrutement', 'Ventes',
  'Développement commercial', 'Support client', 'Assistant de direction', 'Marketing digital',
  'Sécurité informatique', 'Cybersécurité', 'Réseau', 'Administrateur système', 'Scrum master',
  'Designer UX/UI', 'Qualité logicielle', 'Assurance qualité', 'Systèmes embarqués', 'Développement web',
  'Embarqué',
];

/**
 * Location suggestions for target locations (profile.tsx, search-criteria-fields.tsx):
 * major French cities and regions, "Remote"/"Hybrid", the European and
 * global cities/countries this app's sources actually cover (lib/sources/*,
 * notably the Taiwan/Japan-leaning defaults in config.ts).
 */
export const LOCATION_SUGGESTIONS: string[] = [
  // Work mode
  'Remote', 'Hybrid', 'On-site', 'Full remote', 'Télétravail',
  // France - cities
  'Paris', 'Lyon', 'Marseille', 'Toulouse', 'Nice', 'Nantes', 'Strasbourg', 'Montpellier', 'Bordeaux',
  'Lille', 'Rennes', 'Grenoble', 'Toulon', 'Angers', 'Dijon', 'Saint-Étienne', 'Reims', 'Tours', 'Rouen',
  'Nancy',
  // France - regions
  'Île-de-France', 'Auvergne-Rhône-Alpes', 'Nouvelle-Aquitaine', 'Occitanie', 'Hauts-de-France', 'Grand Est',
  "Provence-Alpes-Côte d'Azur", 'Bretagne', 'Normandie',
  // Europe
  'London', 'Berlin', 'Munich', 'Amsterdam', 'Madrid', 'Barcelona', 'Milan', 'Dublin', 'Brussels', 'Zurich',
  'Lisbon', 'Stockholm', 'Copenhagen', 'Vienna', 'Luxembourg',
  // World
  'New York', 'San Francisco', 'Los Angeles', 'Chicago', 'Boston', 'Seattle', 'Austin', 'Toronto',
  'Montreal', 'Tokyo', 'Taipei', 'Singapore', 'Hong Kong', 'Sydney', 'Dubai', 'Bangalore',
  // Countries
  'France', 'Germany', 'United Kingdom', 'Spain', 'Italy', 'Netherlands', 'Switzerland', 'Portugal',
  'Sweden', 'United States', 'Canada', 'Japan', 'Taiwan',
];

/** Target-role suggestions for profile.tsx's "target roles" field, FR + EN. */
export const ROLE_SUGGESTIONS: string[] = [
  'Software Engineer', 'Senior Software Engineer', 'Frontend Engineer', 'Backend Engineer',
  'Full-Stack Engineer', 'Mobile Engineer', 'iOS Engineer', 'Android Engineer', 'DevOps Engineer',
  'Site Reliability Engineer', 'Data Engineer', 'Data Scientist', 'Data Analyst',
  'Machine Learning Engineer', 'AI Engineer', 'QA Engineer', 'Test Engineer', 'Security Engineer',
  'Cybersecurity Analyst', 'Product Manager', 'Product Owner', 'Product Designer', 'UX Designer',
  'UI Designer', 'UX Researcher', 'Engineering Manager', 'Technical Lead', 'Solutions Architect',
  'Cloud Architect', 'System Administrator', 'Project Manager', 'Program Manager', 'Scrum Master',
  'Business Analyst', 'Marketing Manager', 'Growth Marketer', 'Sales Representative',
  'Account Executive', 'Customer Success Manager', 'Customer Support Specialist', 'HR Manager',
  'Recruiter', 'Talent Acquisition Specialist', 'Financial Analyst', 'Accountant', 'Legal Counsel',
  'Executive Assistant', 'Développeur Logiciel', 'Développeur Web', 'Ingénieur DevOps',
  'Chef de Projet', 'Chef de Produit', 'Analyste de Données', 'Ingénieur Data',
  'Développeur Full-Stack', 'Responsable Marketing', 'Chargé de Recrutement', 'Comptable',
  'Assistant de Direction', 'Ingénieur Systèmes Embarqués',
];

/**
 * Company-name suggestions for profile.tsx's "excluded companies" field:
 * the built-in catalog's labels (lib/sources/ats/catalog.ts, lot H5, 83
 * companies verified against their ATS), kept as a plain list of display
 * names here since this dropdown only ever needs a name to exclude, not the
 * catalog's ATS/board metadata that Settings' Company Watch combobox uses.
 * "au plus simple", per lot H6's brief - a static synced copy rather than a
 * live query, since this dropdown must stay 100% local. If catalog.ts's
 * roster changes, update this list to match.
 */
export const COMPANY_SUGGESTIONS: string[] = [
  'Airbnb', 'Stripe', 'Doctolib', 'Algolia', 'Dataiku', 'GitLab', 'Asana', 'Discord', 'Figma', 'Robinhood',
  'Coinbase', 'Instacart', 'Reddit', 'Pinterest', 'Lyft', 'Affirm', 'Gusto', 'Brex', 'Flexport',
  'Databricks', 'Twitch', 'Cloudflare', 'Elastic', 'MongoDB', 'Airtable', 'Duolingo', 'Coursera',
  'Peloton', 'Glossier', 'Chime', 'Squarespace', 'Mirakl', 'Epic Games', 'Riot Games', 'Roblox', 'N26',
  'Wise', 'GetYourGuide', 'Trivago', 'Betterment', 'SoFi', 'Carta', 'Remote', 'Nubank', 'Monzo',
  'Contentsquare', 'Swile', 'Qonto', 'Ledger', 'Aircall', 'Malt', 'BlaBlaCar', 'Scaleway', 'Younited',
  'Doctrine', 'Plaid', 'Ramp', 'Linear', 'Notion', 'OpenAI', 'Perplexity', 'Replit', 'Cohere', 'Vercel',
  'Deel', 'LaunchDarkly', 'Usercentrics', 'Typeform', 'Hotjar', 'Intercom', 'Miro', 'Loom', 'Airbase',
  'Oyster', 'Helloprint', 'Bunq', 'Channable', 'Personio', '44.01', 'Alten', 'Assystem', 'Grab', 'Thales',
];
