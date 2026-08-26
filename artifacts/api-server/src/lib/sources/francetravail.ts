// France Travail (formerly Pôle emploi) "Offres d'emploi v2" API client.
// Docs: https://francetravail.io/produits-partenaires/catalogue/offres-emploi-v2
//
// Auth: OAuth2 client_credentials against the France Travail identity
// provider. Requires FRANCETRAVAIL_CLIENT_ID / FRANCETRAVAIL_CLIENT_SECRET.
//
// Contract-type filtering (lot H3), confirmed live against the API with the
// real credentials in .env (francetravail.io's own docs are a client-only
// SPA and don't expose a plain-text parameter reference):
//   - `typeContrat` takes comma-separated codes (e.g. "CDI,CDD,MIS") in one
//     request - confirmed by GET .../referentiel/typesContrats (12 codes:
//     CCE, CDD, CDI, DDI, DIN, FRA, LIB, MIS, REP, SAI, TTI, DDT) and by a
//     live search combining three of them.
//   - Alternance has no `typeContrat` code of its own. It is a
//     `natureContrat` value instead - confirmed by GET
//     .../referentiel/naturesContrats (19 codes) and a live search:
//     natureContrat=E2,FS returned 19 offers in département 75, every one
//     typeContrat=CDD with natureContrat "Contrat apprentissage" or "Cont.
//     professionnalisation". `typeContrat` and `natureContrat` can't be
//     combined in one request for an OR across both axes (that would AND
//     them, e.g. "CDI AND alternance" = the empty set) - see
//     franceTravailRequestGroups() below.
//   - "Stage" (internship) is not representable at all: neither referentiel
//     lists anything for it. Kept in FRANCE_TRAVAIL_CONTRACT_TYPES for UI
//     parity, but contributes zero requests here - see franceTravailRequestGroups().
//   - `experience` is accepted ("1" moins d'un an, "2" 1 à 3 ans, "3" plus
//     de 3 ans per France Travail's own site) - confirmed live (200, 6
//     results for experience=1 in département 75).
//   - Pagination: `range` windows are capped at 150 results per request
//     (confirmed: range=0-149 returned exactly 150). The response's
//     `Content-Range` header reports the total ("offres 0-149/321"). A
//     `range` starting past the end returns 204 (No Content), not an error.

import { loadConfig, type FranceTravailContractType } from "../config";
import { logger } from "../logger";
import type { RawJob } from "./types";

const TOKEN_URL =
  "https://entreprise.francetravail.fr/connexion/oauth2/access_token?realm=%2Fpartenaire";
const SEARCH_URL = "https://api.francetravail.io/partenaire/offresdemploi/v2/offres/search";
const SCOPE = "api_offresdemploiv2 o2dsoffre";

// One search request returns at most this many offers (confirmed live -
// see module header). Each keyword/contract-type combination pages through
// up to MAX_PAGES of these before moving on, instead of the old hardcoded
// single page of 50 - still a bounded, "polite" cap rather than pulling the
// ~1150 results France Travail's own range ceiling allows.
const PAGE_SIZE = 150;
const MAX_PAGES = 3;

// Alternance (apprentissage + professionnalisation) natureContrat codes -
// see module header.
const ALTERNANCE_NATURE_CONTRAT = "E2,FS";

// typeContrat codes for the three "ordinary" checkboxes. Alternance and
// stage are handled separately - see franceTravailRequestGroups().
function typeContratCode(type: FranceTravailContractType): string | null {
  switch (type) {
    case "cdi":
      return "CDI";
    case "cdd":
      return "CDD";
    case "interim":
      return "MIS";
    case "alternance":
    case "stage":
      return null;
  }
}

// Départements, keywords, contract types and experience level come from
// `sources.franceTravail` in jobblast.config.json. Keep the keyword list
// short - each one is a full search request (or two, with alternance also
// selected - see franceTravailRequestGroups()).
function settings() {
  const { departements, keywords, contractTypes, experienceLevel } = loadConfig().sources.franceTravail;
  return { departements: departements.join(","), queries: keywords, contractTypes, experienceLevel };
}

// Refresh the cached token this many ms before it actually expires.
const TOKEN_SAFETY_MARGIN_MS = 60_000;

type TokenResponse = {
  access_token: string;
  expires_in: number;
  token_type: string;
};

type FranceTravailOffer = {
  id: string;
  intitule: string;
  description?: string;
  entreprise?: { nom?: string };
  lieuTravail?: { libelle?: string };
  typeContrat?: string;
  natureContrat?: string;
  salaire?: { libelle?: string; commentaire?: string };
  dateCreation?: string;
  origineOffre?: { urlOrigine?: string };
};

type FranceTravailSearchResponse = {
  resultats?: FranceTravailOffer[];
};

let cachedToken: { value: string; expiresAt: number } | null = null;

function credentials(): { clientId: string; clientSecret: string } | null {
  const clientId = process.env["FRANCETRAVAIL_CLIENT_ID"];
  const clientSecret = process.env["FRANCETRAVAIL_CLIENT_SECRET"];
  if (!clientId || !clientSecret) return null;
  return { clientId, clientSecret };
}

async function getAccessToken(): Promise<string | null> {
  if (cachedToken && cachedToken.expiresAt > Date.now()) {
    return cachedToken.value;
  }

  const creds = credentials();
  if (!creds) return null;

  const body = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: creds.clientId,
    client_secret: creds.clientSecret,
    scope: SCOPE,
  });

  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });

  if (!res.ok) {
    logger.warn({ status: res.status }, "France Travail OAuth token request failed");
    return null;
  }

  const token = (await res.json()) as TokenResponse;
  cachedToken = {
    value: token.access_token,
    expiresAt: Date.now() + token.expires_in * 1000 - TOKEN_SAFETY_MARGIN_MS,
  };
  return cachedToken.value;
}

function toPostedDate(dateCreation: string | undefined): string {
  const date = dateCreation ? new Date(dateCreation) : new Date();
  if (Number.isNaN(date.getTime())) return new Date().toISOString().slice(0, 10);
  return date.toISOString().slice(0, 10);
}

function toSalaryRange(salaire: FranceTravailOffer["salaire"]): string | null {
  const text = salaire?.libelle ?? salaire?.commentaire ?? null;
  if (!text || text.trim().length === 0 || text.trim().toUpperCase() === "N/A") return null;
  return text.trim();
}

// No dedicated "contract type" column exists on the shared `postings` table
// (see docs/CONFIG.md / lot H3 notes) - same tradeoff the original code
// already made for typeContrat, just extended to include natureContrat when
// it says something typeContrat alone doesn't (alternance). This stays a
// plain line inside the existing `description` text field rather than a
// schema change.
function toContractLine(offer: FranceTravailOffer): string | null {
  const bits: string[] = [];
  if (offer.typeContrat) bits.push(offer.typeContrat);
  if (offer.natureContrat && offer.natureContrat !== "Contrat travail") bits.push(offer.natureContrat);
  return bits.length > 0 ? `Contrat : ${bits.join(" - ")}` : null;
}

/** "offres 0-149/321" -> 321. Null when the header is missing or unparseable. */
function contentRangeTotal(header: string | null): number | null {
  if (!header) return null;
  const match = header.match(/\/(\d+)$/);
  return match ? Number(match[1]) : null;
}

async function searchPage(
  params: URLSearchParams,
  token: string,
): Promise<{ offers: FranceTravailOffer[]; total: number | null }> {
  const res = await fetch(`${SEARCH_URL}?${params.toString()}`, {
    headers: { Authorization: `Bearer ${token}` },
  });

  // 200 = the whole result fit in one page. 206 (Partial Content) = a normal
  // paginated result set. 204 (No Content) = this `range` window starts past
  // the last result - not an error, just "nothing more to page through".
  if (res.status === 204) return { offers: [], total: null };
  if (res.status !== 200 && res.status !== 206) {
    logger.warn({ status: res.status }, "France Travail search request failed");
    return { offers: [], total: null };
  }

  const total = contentRangeTotal(res.headers.get("content-range"));
  const data = (await res.json()) as FranceTravailSearchResponse;
  return { offers: data.resultats ?? [], total };
}

/** One contract-type request axis: at most one of typeContrat/natureContrat - see franceTravailRequestGroups(). */
type FranceTravailContractGroup = { typeContrat?: string; natureContrat?: string };

function buildSearchParams(
  query: string,
  departements: string,
  group: FranceTravailContractGroup,
  experienceLevel: string | null,
  range: string,
): URLSearchParams {
  const params = new URLSearchParams();
  params.set("motsCles", query);
  params.set("departement", departements);
  if (group.typeContrat) params.set("typeContrat", group.typeContrat);
  if (group.natureContrat) params.set("natureContrat", group.natureContrat);
  if (experienceLevel) params.set("experience", experienceLevel);
  params.set("range", range);
  return params;
}

/** Pages through one request (fixed query + contract-type params) up to MAX_PAGES. */
async function searchOffers(
  query: string,
  departements: string,
  group: FranceTravailContractGroup,
  experienceLevel: string | null,
  token: string,
): Promise<FranceTravailOffer[]> {
  const offers: FranceTravailOffer[] = [];
  for (let page = 0; page < MAX_PAGES; page++) {
    const start = page * PAGE_SIZE;
    const end = start + PAGE_SIZE - 1;
    const params = buildSearchParams(query, departements, group, experienceLevel, `${start}-${end}`);
    const { offers: pageOffers, total } = await searchPage(params, token);
    offers.push(...pageOffers);
    if (pageOffers.length < PAGE_SIZE) break; // short page: this was the last one
    if (total !== null && end + 1 >= total) break; // next window would start past the total
  }
  return offers;
}

/**
 * One search needs a separate request per axis it filters on, because the
 * API ANDs whatever parameters are present in a single call: a request with
 * both `typeContrat=CDI` and `natureContrat=E2,FS` would mean "CDI AND
 * alternance", which alternance offers (always typeContrat=CDD) can never
 * satisfy. So "CDI + Alternance" selected together is two requests merged
 * afterwards, not one - same OR semantics the checkboxes imply.
 *
 * Empty `contractTypes` (today's default) -> one request, no contract-type
 * param at all: unchanged behavior. A non-empty selection that resolves to
 * nothing representable (i.e. only "stage") -> zero requests, deliberately:
 * France Travail has no internship listings, so silently falling back to
 * "every contract type" would misrepresent what was asked for.
 */
export function franceTravailRequestGroups(
  contractTypes: readonly FranceTravailContractType[],
): FranceTravailContractGroup[] {
  if (contractTypes.length === 0) return [{}];

  const typeCodes = contractTypes
    .map((type) => typeContratCode(type))
    .filter((code): code is string => code !== null);
  const wantsAlternance = contractTypes.includes("alternance");

  const groups: FranceTravailContractGroup[] = [];
  if (typeCodes.length > 0) groups.push({ typeContrat: typeCodes.join(",") });
  if (wantsAlternance) groups.push({ natureContrat: ALTERNANCE_NATURE_CONTRAT });
  return groups;
}

async function searchKeyword(
  query: string,
  token: string,
  departements: string,
  contractTypes: readonly FranceTravailContractType[],
  experienceLevel: string | null,
): Promise<FranceTravailOffer[]> {
  const groups = franceTravailRequestGroups(contractTypes);
  if (groups.length === 0) return [];

  const results = await Promise.all(
    groups.map((group) => searchOffers(query, departements, group, experienceLevel, token)),
  );
  return results.flat();
}

export async function fetchFranceTravailJobs(): Promise<RawJob[]> {
  if (!credentials()) {
    logger.info(
      "Skipping France Travail: FRANCETRAVAIL_CLIENT_ID/FRANCETRAVAIL_CLIENT_SECRET not set",
    );
    return [];
  }

  const token = await getAccessToken();
  if (!token) {
    logger.warn("Skipping France Travail: failed to obtain an access token");
    return [];
  }

  const { departements, queries, contractTypes, experienceLevel } = settings();

  if (contractTypes.length > 0 && franceTravailRequestGroups(contractTypes).length === 0) {
    logger.info(
      { contractTypes },
      "France Travail: none of the selected contract types exist in this API (e.g. stage/internship) - contributing zero results",
    );
  }

  const results = await Promise.allSettled(
    queries.map((query) => searchKeyword(query, token, departements, contractTypes, experienceLevel)),
  );
  const offersById = new Map<string, FranceTravailOffer>();
  results.forEach((result, index) => {
    if (result.status === "fulfilled") {
      for (const offer of result.value) offersById.set(offer.id, offer);
    } else {
      logger.warn({ query: queries[index], err: result.reason }, "France Travail query failed");
    }
  });

  return Array.from(offersById.values()).map((offer) => ({
    source: "France Travail",
    title: offer.intitule,
    company: offer.entreprise?.nom ?? "Entreprise non communiquée",
    location: offer.lieuTravail?.libelle ?? "",
    url:
      offer.origineOffre?.urlOrigine ??
      `https://candidat.francetravail.fr/offres/recherche/detail/${offer.id}`,
    description: [offer.description, toContractLine(offer)].filter(Boolean).join("\n\n"),
    postedDate: toPostedDate(offer.dateCreation),
    salaryRange: toSalaryRange(offer.salaire),
  }));
}

