import { createAuthClient } from "better-auth/react";

/**
 * Better Auth browser client. Same-origin; talks to /api/auth/*.
 *
 * Generic OAuth providers go through `signIn.social` like the built-in ones,
 * so no client plugin is needed for OIDC.
 */
export const authClient = createAuthClient();
export const { useSession, signIn, signUp, signOut } = authClient;
