import { LOCAL_USER_ID } from "@workspace/db";

/**
 * What GET /auth/session reports on a self-hosted install. There is no login
 * screen and no password, so this is a constant rather than a query: the
 * frontend only needs to know that somebody is signed in.
 */
export const LOCAL_USER = {
  id: LOCAL_USER_ID,
  email: "local@jobblast.local",
  displayName: "Local user",
} as const;
