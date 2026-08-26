// France Travail (formerly Pôle emploi) "Offres d'emploi v2" API client.
// Docs: https://francetravail.io/produits-partenaires/catalogue/offres-emploi-v2
//
// Auth: OAuth2 client_credentials against the France Travail identity
// provider. Requires FRANCETRAVAIL_CLIENT_ID / FRANCETRAVAIL_CLIENT_SECRET.

import { loadConfig } from "../config";
import { logger } from "../logger";
import type { RawJob } from "./types";

const TOKEN_URL =
  "https://entreprise.francetravail.fr/connexion/oauth2/access_token?realm=%2Fpartenaire";
const SEARCH_URL = "https://api.francetravail.io/partenaire/offresdemploi/v2/offres/search";
const SCOPE = "api_offresdemploiv2 o2dsoffre";
// Départements and keywords come from `sources.franceTravail` in
// jobblast.config.json. Keep the keyword list short - each one is a full
// search request.
function settings() {
  const { departements, keywords } = loadConfig().sources.franceTravail;
  return { departements: departements.join(","), queries: keywords };
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

async function searchOffers(
  query: string,
  token: string,
  departements: string,
): Promise<FranceTravailOffer[]> {
  const params = new URLSearchParams({
    motsCles: query,
    departement: departements,
    range: "0-49",
  });
  const res = await fetch(`${SEARCH_URL}?${params.toString()}`, {
    headers: { Authorization: `Bearer ${token}` },
  });

  // The API returns 206 (Partial Content) for a normal paginated result set.
  if (res.status !== 200 && res.status !== 206) {
    logger.warn({ query, status: res.status }, "France Travail search request failed");
    return [];
  }

  const data = (await res.json()) as FranceTravailSearchResponse;
  return data.resultats ?? [];
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

  const { departements, queries } = settings();
  const results = await Promise.allSettled(
    queries.map((query) => searchOffers(query, token, departements)),
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
    description: [offer.description, offer.typeContrat].filter(Boolean).join("\n\n"),
    postedDate: toPostedDate(offer.dateCreation),
    salaryRange: toSalaryRange(offer.salaire),
  }));
}
