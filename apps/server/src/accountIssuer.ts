import { config } from "./config";
import { OIDC_PROVIDER_ID } from "./oidc";

/**
 * The namespace Better Auth 1.7 stores in `account.issuer` alongside
 * `accountId`, which together identify an account uniquely.
 *
 * Every value here must match what the running provider writes, or an existing
 * identity stops being recognised on the next sign-in and picks up a second
 * account row. Credential accounts use a synthetic local namespace, Google
 * declares its own issuer, and a generic OAuth provider uses its configured
 * `accountIssuer` (pinned to `OIDC_ISSUER` by `buildOidcProviderConfig`).
 * Anything else falls back to the documented synthetic OAuth form.
 */
export function accountIssuerFor(providerId: string): string {
	if (providerId === CREDENTIAL_PROVIDER_ID) return CREDENTIAL_ACCOUNT_ISSUER;
	if (providerId === "google") return "https://accounts.google.com";
	if (providerId === OIDC_PROVIDER_ID && config.oidc) return config.oidc.issuer;
	return `local:oauth:${encodeURIComponent(providerId)}`;
}

export const CREDENTIAL_PROVIDER_ID = "credential";
export const CREDENTIAL_ACCOUNT_ISSUER = "local:credential";
