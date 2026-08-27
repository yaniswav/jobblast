// Built-in company catalog (lot H5): companies known in advance to run one
// of the 8 ATSs Company Watch supports (see detect.ts's header), so a
// visitor can find one by typing its name ("Thales") instead of hunting down
// its career page URL and pasting it in. Used by GET /companies/catalog
// (routes/settings.ts) and the Settings page's Company Watch autocomplete.
//
// CONTRACT, checked by catalog.test.ts (no network - it only re-runs
// detectAts, the same pure function the real "paste a URL" path uses):
//   - `id` is unique and a plain lowercase-kebab slug (used as the
//     JOBBLAST_INSTANCE_WATCHES value and as the React list key).
//   - `careerUrl` is a URL detectAts() recognizes, and the `ats`/`board` it
//     returns match this entry's own `ats`/`board` fields exactly.
// Both were also checked against the *network* during this lot: every entry
// below passed a real fetch through its ATS's adapter (200, with the postings
// count noted where it was zero at verification time - a company legitimately
// has no open roles some days, that is not a broken entry). Companies tried
// and rejected because the account did not exist, 404'd, or the platform
// (SmartRecruiters) turned out to return 200 with an empty list for *any*
// name, real or not, so an empty result there proves nothing: Bic, Ubisoft,
// Visa, Ikea, Skechers, McDonald's, Adidas, Deloitte, Genpact, Docplanner,
// LinkedIn, Michael Page, Webhelp, Teleperformance, Amadeus, Bureau Veritas,
// Nokia, Volvo, Electrolux (all SmartRecruiters, all unconfirmed). That half
// is not re-checked in CI (this file otherwise never dials out), so an entry
// that quietly stops matching reality is bit rot: if you find one, remove it
// rather than leaving it for a confused user to hit at runtime.
//
// Only companies on a supported ATS are listed. Most large French
// conglomerates (LVMH, TotalEnergies, Orange, SNCF, BNP Paribas, L'Oreal,
// Carrefour, Renault, EDF, ...) run SuccessFactors, Taleo or an in-house
// system, none of which this app can fetch. Workday in particular is
// under-represented below (Thales only): its board id encodes a tenant, a
// numbered pod (wd1, wd3, wd5...) and a site name, none of which are
// guessable from the company name alone - every other large employer tried
// (Airbus, Safran, Capgemini, Adobe, Salesforce, Visa) 404'd or 422'd on the
// pod/site guesses tried. The catalog grows by usage and PRs from here, not
// by exhausting this one ATS's guess space today.

import type { AtsId } from "../../config";

export type CompanyCatalogEntry = {
  /** Stable, lowercase-kebab id - also the JOBBLAST_INSTANCE_WATCHES value. */
  id: string;
  label: string;
  /** Free-text sector, matched by search (catalog-search.ts) as well as the label. */
  sector: string;
  ats: AtsId;
  /** ATS-specific board/account identifier - must equal what detectAts(careerUrl) returns. */
  board: string;
  careerUrl: string;
};

export const COMPANY_CATALOG: CompanyCatalogEntry[] = [
  // ---------------------------------------------------------------------
  // Greenhouse (45)
  // ---------------------------------------------------------------------
  { id: "airbnb", label: "Airbnb", sector: "Travel & Hospitality", ats: "greenhouse", board: "airbnb", careerUrl: "https://boards.greenhouse.io/airbnb" },
  { id: "stripe", label: "Stripe", sector: "Fintech / Payments", ats: "greenhouse", board: "stripe", careerUrl: "https://boards.greenhouse.io/stripe" },
  { id: "doctolib", label: "Doctolib", sector: "Healthtech", ats: "greenhouse", board: "doctolib", careerUrl: "https://boards.greenhouse.io/doctolib" },
  { id: "algolia", label: "Algolia", sector: "Search / Developer Tools", ats: "greenhouse", board: "algolia", careerUrl: "https://boards.greenhouse.io/algolia" },
  { id: "dataiku", label: "Dataiku", sector: "Data & AI", ats: "greenhouse", board: "dataiku", careerUrl: "https://boards.greenhouse.io/dataiku" },
  { id: "gitlab", label: "GitLab", sector: "Developer Tools", ats: "greenhouse", board: "gitlab", careerUrl: "https://boards.greenhouse.io/gitlab" },
  { id: "asana", label: "Asana", sector: "Productivity Software", ats: "greenhouse", board: "asana", careerUrl: "https://boards.greenhouse.io/asana" },
  { id: "discord", label: "Discord", sector: "Social / Gaming", ats: "greenhouse", board: "discord", careerUrl: "https://boards.greenhouse.io/discord" },
  { id: "figma", label: "Figma", sector: "Design Software", ats: "greenhouse", board: "figma", careerUrl: "https://boards.greenhouse.io/figma" },
  { id: "robinhood", label: "Robinhood", sector: "Fintech", ats: "greenhouse", board: "robinhood", careerUrl: "https://boards.greenhouse.io/robinhood" },
  { id: "coinbase", label: "Coinbase", sector: "Crypto / Fintech", ats: "greenhouse", board: "coinbase", careerUrl: "https://boards.greenhouse.io/coinbase" },
  { id: "instacart", label: "Instacart", sector: "Delivery / Retail Tech", ats: "greenhouse", board: "instacart", careerUrl: "https://boards.greenhouse.io/instacart" },
  { id: "reddit", label: "Reddit", sector: "Social Media", ats: "greenhouse", board: "reddit", careerUrl: "https://boards.greenhouse.io/reddit" },
  { id: "pinterest", label: "Pinterest", sector: "Social Media", ats: "greenhouse", board: "pinterest", careerUrl: "https://boards.greenhouse.io/pinterest" },
  { id: "lyft", label: "Lyft", sector: "Transportation", ats: "greenhouse", board: "lyft", careerUrl: "https://boards.greenhouse.io/lyft" },
  { id: "affirm", label: "Affirm", sector: "Fintech", ats: "greenhouse", board: "affirm", careerUrl: "https://boards.greenhouse.io/affirm" },
  { id: "gusto", label: "Gusto", sector: "HR Tech", ats: "greenhouse", board: "gusto", careerUrl: "https://boards.greenhouse.io/gusto" },
  { id: "brex", label: "Brex", sector: "Fintech", ats: "greenhouse", board: "brex", careerUrl: "https://boards.greenhouse.io/brex" },
  { id: "flexport", label: "Flexport", sector: "Logistics", ats: "greenhouse", board: "flexport", careerUrl: "https://boards.greenhouse.io/flexport" },
  { id: "databricks", label: "Databricks", sector: "Data & AI", ats: "greenhouse", board: "databricks", careerUrl: "https://boards.greenhouse.io/databricks" },
  { id: "twitch", label: "Twitch", sector: "Gaming / Streaming", ats: "greenhouse", board: "twitch", careerUrl: "https://boards.greenhouse.io/twitch" },
  { id: "cloudflare", label: "Cloudflare", sector: "Cloud Infrastructure / Security", ats: "greenhouse", board: "cloudflare", careerUrl: "https://boards.greenhouse.io/cloudflare" },
  { id: "elastic", label: "Elastic", sector: "Search / Data Infrastructure", ats: "greenhouse", board: "elastic", careerUrl: "https://boards.greenhouse.io/elastic" },
  { id: "mongodb", label: "MongoDB", sector: "Database / Data Infrastructure", ats: "greenhouse", board: "mongodb", careerUrl: "https://boards.greenhouse.io/mongodb" },
  { id: "airtable", label: "Airtable", sector: "Productivity Software", ats: "greenhouse", board: "airtable", careerUrl: "https://boards.greenhouse.io/airtable" },
  { id: "duolingo", label: "Duolingo", sector: "Edtech", ats: "greenhouse", board: "duolingo", careerUrl: "https://boards.greenhouse.io/duolingo" },
  { id: "coursera", label: "Coursera", sector: "Edtech", ats: "greenhouse", board: "coursera", careerUrl: "https://boards.greenhouse.io/coursera" },
  { id: "peloton", label: "Peloton", sector: "Fitness Tech", ats: "greenhouse", board: "peloton", careerUrl: "https://boards.greenhouse.io/peloton" },
  { id: "glossier", label: "Glossier", sector: "Beauty Retail", ats: "greenhouse", board: "glossier", careerUrl: "https://boards.greenhouse.io/glossier" },
  { id: "chime", label: "Chime", sector: "Fintech", ats: "greenhouse", board: "chime", careerUrl: "https://boards.greenhouse.io/chime" },
  { id: "squarespace", label: "Squarespace", sector: "Web / SaaS", ats: "greenhouse", board: "squarespace", careerUrl: "https://boards.greenhouse.io/squarespace" },
  { id: "mirakl", label: "Mirakl", sector: "Ecommerce / SaaS", ats: "greenhouse", board: "mirakl", careerUrl: "https://boards.greenhouse.io/mirakl" },
  { id: "epicgames", label: "Epic Games", sector: "Gaming", ats: "greenhouse", board: "epicgames", careerUrl: "https://boards.greenhouse.io/epicgames" },
  { id: "riotgames", label: "Riot Games", sector: "Gaming", ats: "greenhouse", board: "riotgames", careerUrl: "https://boards.greenhouse.io/riotgames" },
  { id: "roblox", label: "Roblox", sector: "Gaming", ats: "greenhouse", board: "roblox", careerUrl: "https://boards.greenhouse.io/roblox" },
  { id: "n26", label: "N26", sector: "Fintech (Neobank)", ats: "greenhouse", board: "n26", careerUrl: "https://boards.greenhouse.io/n26" },
  { id: "wise", label: "Wise", sector: "Fintech (Money Transfer)", ats: "greenhouse", board: "wise", careerUrl: "https://boards.greenhouse.io/wise" },
  { id: "getyourguide", label: "GetYourGuide", sector: "Travel / Marketplace", ats: "greenhouse", board: "getyourguide", careerUrl: "https://boards.greenhouse.io/getyourguide" },
  { id: "trivago", label: "Trivago", sector: "Travel", ats: "greenhouse", board: "trivago", careerUrl: "https://boards.greenhouse.io/trivago" },
  { id: "betterment", label: "Betterment", sector: "Fintech", ats: "greenhouse", board: "betterment", careerUrl: "https://boards.greenhouse.io/betterment" },
  { id: "sofi", label: "SoFi", sector: "Fintech", ats: "greenhouse", board: "sofi", careerUrl: "https://boards.greenhouse.io/sofi" },
  { id: "carta", label: "Carta", sector: "Fintech / Equity Management", ats: "greenhouse", board: "carta", careerUrl: "https://boards.greenhouse.io/carta" },
  // 0 open postings at verification time - legitimate, live data.
  { id: "remote", label: "Remote", sector: "HR Tech (Global Employment)", ats: "greenhouse", board: "remote", careerUrl: "https://boards.greenhouse.io/remote" },
  { id: "nubank", label: "Nubank", sector: "Fintech", ats: "greenhouse", board: "nubank", careerUrl: "https://boards.greenhouse.io/nubank" },
  { id: "monzo", label: "Monzo", sector: "Fintech (Neobank)", ats: "greenhouse", board: "monzo", careerUrl: "https://boards.greenhouse.io/monzo" },

  // ---------------------------------------------------------------------
  // Lever (11)
  // ---------------------------------------------------------------------
  { id: "contentsquare", label: "Contentsquare", sector: "Analytics", ats: "lever", board: "contentsquare", careerUrl: "https://jobs.lever.co/contentsquare" },
  { id: "swile", label: "Swile", sector: "Fintech / Employee Benefits", ats: "lever", board: "swile", careerUrl: "https://jobs.lever.co/swile" },
  { id: "qonto", label: "Qonto", sector: "Fintech", ats: "lever", board: "qonto", careerUrl: "https://jobs.lever.co/qonto" },
  { id: "ledger", label: "Ledger", sector: "Crypto Hardware", ats: "lever", board: "ledger", careerUrl: "https://jobs.lever.co/ledger" },
  { id: "aircall", label: "Aircall", sector: "SaaS / Business Telephony", ats: "lever", board: "aircall", careerUrl: "https://jobs.lever.co/aircall" },
  { id: "malt", label: "Malt", sector: "Freelance Marketplace", ats: "lever", board: "malt", careerUrl: "https://jobs.lever.co/malt" },
  { id: "blablacar", label: "BlaBlaCar", sector: "Transportation", ats: "lever", board: "blablacar", careerUrl: "https://jobs.lever.co/blablacar" },
  { id: "scaleway", label: "Scaleway", sector: "Cloud Infrastructure", ats: "lever", board: "scaleway", careerUrl: "https://jobs.lever.co/scaleway" },
  { id: "younited", label: "Younited", sector: "Fintech", ats: "lever", board: "younited", careerUrl: "https://jobs.lever.co/younited" },
  { id: "doctrine", label: "Doctrine", sector: "Legal Tech", ats: "lever", board: "doctrine", careerUrl: "https://jobs.lever.co/doctrine" },
  // 0 open postings at verification time - legitimate, live data.
  { id: "plaid", label: "Plaid", sector: "Fintech (API)", ats: "lever", board: "plaid", careerUrl: "https://jobs.lever.co/plaid" },

  // ---------------------------------------------------------------------
  // Ashby (10)
  // ---------------------------------------------------------------------
  { id: "ramp", label: "Ramp", sector: "Fintech", ats: "ashby", board: "ramp", careerUrl: "https://jobs.ashbyhq.com/ramp" },
  { id: "linear", label: "Linear", sector: "Developer Tools", ats: "ashby", board: "linear", careerUrl: "https://jobs.ashbyhq.com/linear" },
  { id: "notion", label: "Notion", sector: "Productivity Software", ats: "ashby", board: "notion", careerUrl: "https://jobs.ashbyhq.com/notion" },
  { id: "openai", label: "OpenAI", sector: "AI", ats: "ashby", board: "openai", careerUrl: "https://jobs.ashbyhq.com/openai" },
  { id: "perplexity", label: "Perplexity", sector: "AI Search", ats: "ashby", board: "perplexity", careerUrl: "https://jobs.ashbyhq.com/perplexity" },
  { id: "replit", label: "Replit", sector: "Developer Tools", ats: "ashby", board: "replit", careerUrl: "https://jobs.ashbyhq.com/replit" },
  { id: "cohere", label: "Cohere", sector: "AI", ats: "ashby", board: "cohere", careerUrl: "https://jobs.ashbyhq.com/cohere" },
  // 0 open postings at verification time - legitimate, live data.
  { id: "vercel", label: "Vercel", sector: "Developer Tools", ats: "ashby", board: "vercel", careerUrl: "https://jobs.ashbyhq.com/vercel" },
  { id: "deel", label: "Deel", sector: "HR Tech (Global Employment)", ats: "ashby", board: "deel", careerUrl: "https://jobs.ashbyhq.com/deel" },
  { id: "launchdarkly", label: "LaunchDarkly", sector: "Developer Tools", ats: "ashby", board: "launchdarkly", careerUrl: "https://jobs.ashbyhq.com/launchdarkly" },

  // ---------------------------------------------------------------------
  // Workable (8)
  // ---------------------------------------------------------------------
  { id: "usercentrics", label: "Usercentrics", sector: "Privacy Tech", ats: "workable", board: "usercentrics", careerUrl: "https://apply.workable.com/usercentrics" },
  // 0 open postings at verification time - legitimate, live data.
  { id: "typeform", label: "Typeform", sector: "SaaS / Forms", ats: "workable", board: "typeform", careerUrl: "https://apply.workable.com/typeform" },
  { id: "hotjar", label: "Hotjar", sector: "Analytics", ats: "workable", board: "hotjar", careerUrl: "https://apply.workable.com/hotjar" },
  { id: "intercom", label: "Intercom", sector: "Customer Messaging SaaS", ats: "workable", board: "intercom", careerUrl: "https://apply.workable.com/intercom" },
  { id: "miro", label: "Miro", sector: "Productivity Software", ats: "workable", board: "miro", careerUrl: "https://apply.workable.com/miro" },
  { id: "loom", label: "Loom", sector: "Video / Productivity", ats: "workable", board: "loom", careerUrl: "https://apply.workable.com/loom" },
  { id: "airbase", label: "Airbase", sector: "Fintech / Spend Management", ats: "workable", board: "airbase", careerUrl: "https://apply.workable.com/airbase" },
  { id: "oyster", label: "Oyster", sector: "HR Tech (Global Employment)", ats: "workable", board: "oyster", careerUrl: "https://apply.workable.com/oyster" },

  // ---------------------------------------------------------------------
  // Recruitee (3)
  // ---------------------------------------------------------------------
  { id: "helloprint", label: "Helloprint", sector: "Print / Ecommerce", ats: "recruitee", board: "helloprint", careerUrl: "https://helloprint.recruitee.com" },
  { id: "bunq", label: "Bunq", sector: "Fintech (Neobank)", ats: "recruitee", board: "bunq", careerUrl: "https://bunq.recruitee.com" },
  { id: "channable", label: "Channable", sector: "Ecommerce / SaaS", ats: "recruitee", board: "channable", careerUrl: "https://channable.recruitee.com" },

  // ---------------------------------------------------------------------
  // Personio (2)
  // ---------------------------------------------------------------------
  { id: "personio", label: "Personio", sector: "HR Tech", ats: "personio", board: "personio.de", careerUrl: "https://personio.jobs.personio.de" },
  { id: "4401", label: "44.01", sector: "Climate Tech / Carbon Capture", ats: "personio", board: "4401.de", careerUrl: "https://4401.jobs.personio.de" },

  // ---------------------------------------------------------------------
  // SmartRecruiters (3) - the listing endpoint returns 200 with an empty
  // list for literally any company name, real or not (verified against a
  // nonsense slug), so unlike every other ATS here a nonzero posting count
  // was the only usable signal - see the rejected list up top.
  // ---------------------------------------------------------------------
  { id: "alten", label: "Alten", sector: "Engineering Consulting", ats: "smartrecruiters", board: "Alten", careerUrl: "https://careers.smartrecruiters.com/Alten" },
  { id: "assystem", label: "Assystem", sector: "Engineering Consulting", ats: "smartrecruiters", board: "Assystem", careerUrl: "https://careers.smartrecruiters.com/Assystem" },
  { id: "grab", label: "Grab", sector: "Transportation / Delivery", ats: "smartrecruiters", board: "Grab", careerUrl: "https://careers.smartrecruiters.com/Grab" },

  // ---------------------------------------------------------------------
  // Workday (1) - see the file header on why this ATS is thin.
  // ---------------------------------------------------------------------
  { id: "thales", label: "Thales", sector: "Aerospace & Defense", ats: "workday", board: "thales/wd3/Careers", careerUrl: "https://thales.wd3.myworkdayjobs.com/Careers" },
];
