// Ambient "who is this request for" context.
//
// Layer 1 of the three isolation layers in docs/SAAS-ARCHITECTURE.md: the
// auth middleware resolves a user (from the session cookie in `saas`, from
// the implicit local user in `selfhosted`) and runs the rest of the request
// inside userContext.run(), so zero-argument readers like loadConfig() and
// the AI provider factory resolve per user without threading a parameter
// through fifteen deep call sites in the source fetchers and PDF renderers.
//
// This is deliberately NOT how database access is scoped. Ambient context is
// fine for read-only configuration; a forgotten scope on a query is a data
// leak, so every function in lib/repo/ takes `userId` as its first argument
// instead (layer 2), enforced by lib/scoping.test.ts (layer 3).

import { AsyncLocalStorage } from "node:async_hooks";

export type UserContext = { userId: string };

const storage = new AsyncLocalStorage<UserContext>();

/** Runs `fn` with `userId` as the ambient user for everything it awaits. */
export function runWithUser<T>(userId: string, fn: () => T): T {
  return storage.run({ userId }, fn);
}

/** The ambient user id, or null outside any request/job context. */
export function currentUserId(): string | null {
  return storage.getStore()?.userId ?? null;
}
