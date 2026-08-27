// Smart-search vocabularies and pure helpers (lot H6): static, local,
// deterministic autocomplete for the tag inputs across the app (profile
// targeting, onboarding/Settings search criteria) - zero network, zero AI,
// same idea as lib/sources/ats/catalog-search.ts's foldForSearch on the
// server, but this module is the browser-side twin since these dropdowns
// filter entirely client-side against a static list.
//
// Lot K1: ROLE_SUGGESTIONS below also merges in ROME_ROLE_SUGGESTIONS
// (rome-roles.ts, generated from France Travail's ROME 4.0 open data by
// scripts/src/build-rome-suggestions.ts - see that file's header for the
// source/license/curation writeup), so the "target roles" field scales from
// the ~140 hand-picked roles here to France Travail's ~3200-entry official
// trade nomenclature.
//
// Nothing here talks to the backend. A user typing free text that matches
// nothing in these lists behaves exactly as before this lot: the dropdown
// just stays empty and the raw text is still addable.

import { ROME_ROLE_SUGGESTIONS } from './rome-roles';

// Lot K1: fold() is memoized. ROLE_SUGGESTIONS now merges in
// ROME_ROLE_SUGGESTIONS (rome-roles.ts, ~3200 entries), and filterSuggestions
// folds every pool item on every call - unmemoized, that is ~3200 fresh
// normalize()+regex passes per keystroke. fold() is pure, so caching by
// input value is always safe; the same pool strings get folded again and
// again across keystrokes/renders, so only the first call per distinct
// string ever pays the real cost. ROLE_SUGGESTIONS is warmed once below at
// module load, so no keystroke ever hits a cold cache for it. Unbounded
// growth from arbitrary typed queries is not a real concern here - a
// self-hosted app, one browser tab, at most a few hundred short strings a
// session.
const foldCache = new Map<string, string>();

/** Strips diacritics and lowercases, so "é"/"e" and "Thalès"/"thales" compare equal. */
export function fold(value: string): string {
  const cached = foldCache.get(value);
  if (cached !== undefined) return cached;
  const folded = value
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '') // combining diacritical marks left behind by NFD
    .toLowerCase()
    .trim();
  foldCache.set(value, folded);
  return folded;
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

/**
 * Merges two suggestion pools, `primary` first and in its own order, then
 * every `secondary` item that doesn't fold to the same key as something
 * already in `primary` or already added from `secondary` itself (lot K1:
 * used to merge the hand-picked ROLE_SUGGESTIONS with the generated
 * ROME_ROLE_SUGGESTIONS - see that export's doc).
 */
function mergeSuggestionPools(primary: readonly string[], secondary: readonly string[]): string[] {
  const seen = new Set(primary.map(fold));
  const merged = [...primary];
  for (const item of secondary) {
    const key = fold(item);
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(item);
  }
  return merged;
}

// ---------------------------------------------------------------------------
// Vocabularies
// ---------------------------------------------------------------------------

/**
 * Skill / keyword suggestions for search-criteria keywords (search-criteria-fields.tsx,
 * used by onboarding + Settings). Extracted and generalized from the skill
 * labels of artifacts/api-server/src/lib/anonymous-match.ts's KEYWORD_RULES
 * (the ~177 rules that drive the anonymous trial matcher, since lot J1 - was
 * ~74, tech/business-function only) - that file stays the single source of
 * truth for actual matching logic; this is only a flat list of strings for
 * autocomplete, with combined labels split out ("PostgreSQL/MySQL" ->
 * "PostgreSQL", "MySQL") and a handful of common French synonyms added,
 * since this app's postings are bilingual (FR/EN). Lot J1 broadened this
 * from tech/business-function alone to the major French trades - health,
 * BTP, retail, hospitality, logistics, admin/finance, education/social,
 * legal/HR, marketing, industry, security/cleaning, real estate,
 * banking/insurance, agriculture - so a nurse's or a mason's CV finds its
 * own vocabulary here too, not just a developer's. A term typed here that
 * isn't in this list still works exactly as before - this only feeds the
 * dropdown, never validates input.
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
  // Santé (lot J1)
  'Infirmier', 'Infirmière', "Infirmier diplômé d'État", 'IDE (infirmier)', 'Aide-soignant', 'Aide-soignante',
  'Médecin', 'Médecin généraliste', 'Pharmacien', 'Pharmacienne', 'Kinésithérapeute', 'Kiné', 'Ambulancier',
  'Ambulancière', 'Sage-femme', 'EHPAD', 'Bloc opératoire', 'Soins infirmiers', 'Dentiste',
  'Auxiliaire de puériculture',
  // BTP / artisanat (lot J1)
  'Maçon', 'Maçonnerie', 'Électricien', 'Électricité', 'Plombier', 'Plomberie', 'Chauffagiste', 'Menuisier',
  'Menuiserie', 'Peintre en bâtiment', 'Conducteur de travaux', 'Chef de chantier', 'Gros œuvre', 'Second œuvre',
  'Couvreur', 'Carreleur', 'Charpentier', 'BTP',
  // Vente / commerce (lot J1)
  'Vendeur', 'Vendeuse', 'Commercial', 'Commerciale', 'Conseiller clientèle', 'Conseillère clientèle',
  'Chargé de clientèle', 'Caissier', 'Caissière', 'Merchandising', 'Négociation commerciale',
  'Prospection commerciale', 'B2B', 'B2C', 'Grande distribution', 'Technico-commercial',
  // Hôtellerie-restauration (lot J1)
  'Cuisinier', 'Cuisinière', 'Chef de cuisine', 'Chef de partie', 'Commis de cuisine', 'Serveur en salle',
  'Serveuse', 'Réceptionniste', 'Barman', 'Barmaid', 'HACCP', 'Hôtellerie-restauration', 'Restauration collective',
  'Service en salle', 'Plonge',
  // Logistique / transport (lot J1)
  'Cariste', 'Préparateur de commandes', 'Préparatrice de commandes', 'Chauffeur PL', 'Chauffeur SPL',
  'Chauffeur-livreur', 'CACES', 'Magasinier', 'Magasinière', 'Logistique', 'Entrepôt', 'Livreur', 'Permis PL',
  'Permis SPL', 'Gestion des stocks',
  // Admin / compta / finance (lot J1)
  'Comptable', 'Comptabilité générale', 'Gestion de la paie', 'Payroll', 'Assistant administratif',
  'Assistante administrative', 'Facturation', 'Contrôle de gestion', 'Contrôleur de gestion', 'Audit', 'Auditeur',
  'Trésorerie', 'Fiscalité',
  // Éducation / social (lot J1)
  'Enseignant', 'Enseignante', 'Formateur', 'Formatrice', 'Éducateur spécialisé', 'Éducatrice spécialisée',
  'Petite enfance', 'Auxiliaire de vie', 'Animateur socioculturel', 'Animatrice socioculturelle', 'BAFA', 'AESH',
  'Éducateur de jeunes enfants',
  // RH / juridique (lot J1)
  'Gestionnaire RH', "Cabinet d'avocats", 'Juriste', 'Paralegal', 'Droit social', 'Droit du travail', 'Avocat',
  'Contentieux', 'Chargé de recrutement',
  // Marketing / com (lot J1)
  'Community manager', 'SEO', 'Référencement naturel', 'Rédaction web', 'Rédacteur web', 'Copywriting',
  'Graphiste', 'Chargé de communication', 'Réseaux sociaux', 'Social media', 'Content marketing',
  // Industrie / production (lot J1)
  'Opérateur de production', 'Opératrice de production', 'Usinage', 'Soudeur', 'Soudeuse', 'Soudure',
  'Maintenance industrielle', 'Technicien de maintenance', 'Contrôle qualité', 'Conducteur de ligne', 'Régleur',
  'Méthodes industrielles', 'Industrialisation',
  // Sécurité / nettoyage / services (lot J1)
  'Agent de sécurité', 'SSIAP', "Agent d'entretien", 'Agent de nettoyage', "Gardien d'immeuble", 'Concierge',
  'Vidéosurveillance', 'Sûreté', 'Agent de ménage', 'Housekeeping',
  // Immobilier (lot J1)
  'Agent immobilier', 'Négociateur immobilier', 'Gestion locative', 'Syndic de copropriété',
  'Property management', 'Transaction immobilière', 'Diagnostiqueur immobilier', 'Chasseur immobilier',
  // Banque / assurance (lot J1)
  'Conseiller bancaire', 'Conseillère bancaire', 'Gestionnaire de sinistres', 'Souscripteur', 'Courtier',
  'Courtière', 'Actuaire', 'Banque de détail', 'Chargé de clientèle bancaire', 'Assurance',
  // Agriculture / paysage (lot J1)
  'Agriculteur', 'Agricultrice', 'Exploitant agricole', 'Ouvrier agricole', 'Paysagiste', 'Élevage',
  'Viticulture', 'Maraîchage', 'Horticulture', 'Agriculture',
  // Certifications / permis (lot J1)
  'Permis B', 'Permis C', 'Permis D', 'Habilitation électrique', 'CAP', 'BEP', 'Bac Pro', 'BTS',
  "Diplôme d'État",
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
  'Nancy', 'Le Havre', 'Villeurbanne', 'Clermont-Ferrand', 'Le Mans', 'Aix-en-Provence', 'Brest', 'Limoges',
  'Amiens', 'Perpignan', 'Metz', 'Besançon', 'Orléans', 'Mulhouse', 'Caen', 'Nîmes', 'Avignon', 'Poitiers',
  'Versailles', 'Pau', 'La Rochelle', 'Annecy', 'Chambéry', 'Bayonne',
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

/**
 * Hand-picked target-role suggestions, FR + EN - kept first in
 * ROLE_SUGGESTIONS below (see that export's own doc) so these still win
 * ranking ties over a same-ranked ROME entry, same as before lot K1.
 */
const HAND_PICKED_ROLE_SUGGESTIONS: string[] = [
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
  // Santé (lot J1)
  "Infirmier Diplômé d'État", 'Infirmière DE', 'Aide-Soignant', 'Aide-Soignante', 'Médecin Généraliste',
  'Pharmacien', 'Kinésithérapeute', 'Ambulancier',
  // BTP / artisanat (lot J1)
  'Maçon', 'Électricien du Bâtiment', 'Plombier Chauffagiste', 'Menuisier', 'Peintre en Bâtiment',
  'Conducteur de Travaux', 'Chef de Chantier', 'Couvreur', 'Charpentier',
  // Vente / commerce (lot J1)
  'Vendeur', 'Vendeuse', 'Commercial Terrain', 'Conseiller Clientèle', 'Chargé de Clientèle', 'Caissier',
  'Technico-Commercial',
  // Hôtellerie-restauration (lot J1)
  'Cuisinier', 'Chef de Cuisine', 'Chef de Partie', 'Serveur en Salle', 'Réceptionniste', 'Barman',
  // Logistique / transport (lot J1)
  'Cariste', 'Préparateur de Commandes', 'Chauffeur Poids Lourd', 'Chauffeur-Livreur', 'Magasinier',
  'Responsable Logistique', 'Agent Logistique',
  // Admin / compta / finance (lot J1)
  'Assistant Administratif', 'Gestionnaire de Paie', 'Contrôleur de Gestion', 'Auditeur Financier', 'Trésorier',
  // Éducation / social (lot J1)
  'Enseignant', 'Formateur', 'Éducateur Spécialisé', 'Auxiliaire de Puériculture', 'Animateur Socioculturel',
  'Assistant Social', 'Assistante Sociale',
  // RH / juridique (lot J1)
  'Gestionnaire RH', 'Juriste', "Juriste d'Entreprise", 'Avocat',
  // Marketing / com (lot J1)
  'Community Manager', 'Chargé de Communication', 'Rédacteur Web', 'Graphiste', 'Responsable SEO',
  // Industrie / production (lot J1)
  'Opérateur de Production', 'Soudeur', 'Technicien de Maintenance', 'Conducteur de Ligne',
  'Responsable Qualité', 'Technicien Méthodes',
  // Sécurité / nettoyage / services (lot J1)
  'Agent de Sécurité', 'Agent SSIAP', "Agent d'Entretien", "Gardien d'Immeuble", 'Agent de Propreté',
  // Immobilier (lot J1)
  'Agent Immobilier', 'Négociateur Immobilier', 'Gestionnaire Locatif',
  // Banque / assurance (lot J1)
  'Conseiller Bancaire', 'Chargé de Clientèle Bancaire', 'Gestionnaire Sinistres', 'Courtier en Assurance',
  // Agriculture / paysage (lot J1)
  'Agriculteur', 'Exploitant Agricole', 'Paysagiste', 'Ouvrier Agricole',
];

/**
 * Target-role suggestions for profile.tsx's "target roles" field
 * (explore.tsx's search bar reuses it too): HAND_PICKED_ROLE_SUGGESTIONS
 * above, kept first and in order, plus France Travail's ROME 4.0 job-title
 * vocabulary (ROME_ROLE_SUGGESTIONS, rome-roles.ts, lot K1) for everything
 * the hand-picked list doesn't already name - deduped by fold() against the
 * hand-picked list, so a ROME entry that folds the same as an existing
 * hand-picked one (e.g. "Maçon") is dropped rather than shown twice.
 */
export const ROLE_SUGGESTIONS: string[] = mergeSuggestionPools(HAND_PICKED_ROLE_SUGGESTIONS, ROME_ROLE_SUGGESTIONS);

// Warms fold()'s cache for the whole merged pool once, at module load,
// rather than paying for it on the first keystroke that touches it (see
// fold()'s own comment above).
for (const suggestion of ROLE_SUGGESTIONS) fold(suggestion);

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
