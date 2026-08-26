// Where an API-key-based provider gets its key from.
//
// Two backends, one signature, resolved fresh on every call:
//
//   selfhosted - the process environment, named by the provider (or, for
//                openai-compatible, by `ai.openaiCompatible.apiKeyEnv`).
//                Exactly today's behavior, including the "empty apiKeyEnv
//                means send no Authorization header" case for a local server.
//   saas       - the acting account's own encrypted key
//                (lib/repo/ai-credentials.ts), decrypted here and nowhere
//                else on the request path.
//
// The resolver is called per generation, never memoized: a decrypted key
// exists inside one provider call and is not kept anywhere afterwards
// (docs/SAAS-ARCHITECTURE.md section 5).

import type { ByokProviderName } from "../config";
import { decryptCredential } from "../repo/ai-credentials";
import { ProviderUnavailableError } from "./errors";

/** Resolves the key for one call. `null` means "send no key at all". */
export type ApiKeyResolver = () => Promise<string | null>;

/** Reads `envVar`, or refuses permanently (this process cannot fix an unset variable). */
export function envApiKeyResolver(providerName: string, envVar: string, hint: string): ApiKeyResolver {
  return async () => {
    const value = process.env[envVar];
    if (!value || value.trim().length === 0) {
      throw new ProviderUnavailableError(providerName, `${envVar} is not set (${hint})`);
    }
    return value;
  };
}

/** Always resolves to "no key", for an endpoint explicitly configured without one. */
export function noApiKeyResolver(): ApiKeyResolver {
  return async () => null;
}

/**
 * Decrypts this account's stored key, for this call only. A missing row is a
 * permanent condition for the account until it saves one, so it surfaces as
 * ProviderUnavailableError and puts that account (and only that account) into
 * template-letter mode.
 */
export function byokApiKeyResolver(userId: string, provider: ByokProviderName): ApiKeyResolver {
  return async () => {
    const key = await decryptCredential(userId, provider);
    if (!key || key.trim().length === 0) {
      throw new ProviderUnavailableError(
        provider,
        "No API key is saved for this account yet (add one in Settings)",
      );
    }
    return key;
  };
}
