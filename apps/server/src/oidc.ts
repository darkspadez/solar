import { config, type OidcConfig } from "./config";
import { sqlite } from "./db";
import { logger } from "./logger";
import { applyUserRole, countActiveAdmins, type UserRole } from "./userRoles";

/**
 * Provider id for the single configurable OpenID Connect provider. It appears
 * in the `account.providerId` column, in `accountLinking.trustedProviders`, and
 * in the callback URL registered at the IdP:
 * `${BETTER_AUTH_URL}/api/auth/callback/oidc`.
 */
export const OIDC_PROVIDER_ID = "oidc";

/**
 * Better Auth's shared OAuth callback route, as a route pattern rather than a
 * concrete URL. The role-sync hook matches on it, and a rename upstream would
 * otherwise make that hook silently stop firing, so `assertOAuthCallbackPath`
 * checks it against the registered routes at startup.
 */
export const OAUTH_CALLBACK_PATH = "/callback/:id";

/**
 * Whether Better Auth still registers the callback route the role-sync hook
 * matches on.
 *
 * Upgrading from 1.6 to 1.7 moved this route and renamed its parameter, which
 * would have turned the hook into a silent no-op that froze admin roles with
 * nothing in the log. Checking at startup makes the next such rename loud.
 */
export function oauthCallbackPathIsRegistered(
	registeredPaths: readonly (string | undefined)[],
): boolean {
	return registeredPaths.includes(OAUTH_CALLBACK_PATH);
}

/** Better Auth's `GenericOAuthConfig` subset this app supplies. */
export interface OidcProviderConfig {
	providerId: string;
	discoveryUrl: string;
	accountIssuer: string;
	clientId: string;
	clientSecret: string;
	scopes: string[];
	pkce: boolean;
	disableSignUp: boolean;
}

/**
 * Builds the generic-OAuth provider entry.
 *
 * Deliberately no `mapProfileToUser`: fields it returns are filtered against
 * the user schema, and `role` is `input: false`, so a role mapped there would
 * be silently dropped. Role assignment happens in `syncOidcRole` instead. The
 * email-domain allowlist is enforced by the `user.create.before` database hook,
 * whose thrown `APIError` reaches the browser as a readable redirect, unlike a
 * throw from `mapProfileToUser` (which the callback surfaces as raw JSON).
 */
export function buildOidcProviderConfig(oidc: OidcConfig): OidcProviderConfig {
	return {
		providerId: OIDC_PROVIDER_ID,
		discoveryUrl: oidc.discoveryUrl,
		// Names the account namespace stored in `account.issuer`. Setting it
		// explicitly also keeps startup resilient: without it, Better Auth
		// aborts provider initialization when the discovery document cannot be
		// fetched, so an IdP that is down or still booting alongside Solar would
		// take the whole server with it. ID-token validation still uses the
		// issuer and JWKS from discovery, so pinning this costs no verification.
		accountIssuer: oidc.issuer,
		clientId: oidc.clientId,
		clientSecret: oidc.clientSecret,
		scopes: oidc.scopes,
		// On by default since 1.7; kept explicit because it is a security
		// property of this flow rather than an incidental default.
		pkce: true,
		disableSignUp: oidc.disableSignUp,
	};
}

/**
 * Decodes a JWT payload without verifying its signature.
 *
 * Safe here because the token never arrives from the browser: it is fetched by
 * the server over TLS in the back-channel code exchange (client secret + PKCE),
 * which is the trust anchor, and then read back from the `account` row we wrote.
 */
export function decodeJwtPayload(
	token: string,
): Record<string, unknown> | null {
	try {
		const segment = token.split(".")[1];
		if (!segment) return null;
		const payload: unknown = JSON.parse(
			Buffer.from(segment, "base64url").toString("utf8"),
		);
		if (typeof payload !== "object" || payload === null) return null;
		if (Array.isArray(payload)) return null;
		return payload as Record<string, unknown>;
	} catch {
		return null;
	}
}

/**
 * Reads a claim by name, falling back to a dotted path.
 *
 * The literal-key lookup comes first so claim names containing dots or colons
 * (Zitadel's `urn:zitadel:iam:org:project:roles`) work, while Keycloak's nested
 * `realm_access.roles` resolves through the path walk.
 */
export function getClaim(
	payload: Record<string, unknown>,
	path: string,
): unknown {
	if (Object.hasOwn(payload, path)) return payload[path];
	let current: unknown = payload;
	for (const segment of path.split(".")) {
		if (typeof current !== "object" || current === null) return undefined;
		if (!Object.hasOwn(current, segment)) return undefined;
		current = (current as Record<string, unknown>)[segment];
	}
	return current;
}

/**
 * Whether a claim value carries `target`, across the shapes the supported IdPs
 * emit: an array of groups (Authentik, Keycloak), an object keyed by role name
 * (Zitadel), or a single or space/comma-separated string. Case-sensitive.
 */
export function claimContains(value: unknown, target: string): boolean {
	if (Array.isArray(value)) return value.some((entry) => entry === target);
	if (typeof value === "string") {
		if (value === target) return true;
		return value
			.split(/[\s,]+/)
			.filter(Boolean)
			.includes(target);
	}
	if (typeof value === "object" && value !== null)
		return Object.hasOwn(value, target);
	return false;
}

/** The role these claims grant. A missing claim means the user is not an admin. */
export function roleFromClaims(
	payload: Record<string, unknown>,
	options: { adminClaim: string; adminValue: string },
): UserRole {
	return claimContains(
		getClaim(payload, options.adminClaim),
		options.adminValue,
	)
		? "admin"
		: "user";
}

let userInfoEndpoint: Promise<string | null> | null = null;

/** Resets the memoized discovery lookup. Test seam. */
export function resetOidcDiscoveryCache(): void {
	userInfoEndpoint = null;
}

async function fetchUserInfoEndpoint(
	discoveryUrl: string,
): Promise<string | null> {
	const response = await fetch(discoveryUrl);
	if (!response.ok) return null;
	const document = (await response.json()) as { userinfo_endpoint?: unknown };
	return typeof document.userinfo_endpoint === "string"
		? document.userinfo_endpoint
		: null;
}

async function getUserInfoEndpoint(
	discoveryUrl: string,
): Promise<string | null> {
	userInfoEndpoint ??= fetchUserInfoEndpoint(discoveryUrl).catch(() => null);
	const endpoint = await userInfoEndpoint;
	// Do not cache a failure: the IdP may simply have been unreachable.
	if (!endpoint) userInfoEndpoint = null;
	return endpoint;
}

interface OidcAccount {
	providerId: string;
	idToken?: string | null;
	accessToken?: string | null;
}

/** The slice of Better Auth's request context `syncOidcRole` needs. */
export interface OidcAuthContext {
	internalAdapter: {
		findAccounts(userId: string): Promise<OidcAccount[]>;
	};
}

/**
 * Claims for this login: the ID token, falling back to the userinfo endpoint
 * when the configured claim is absent there (Authelia, and Keycloak mappers
 * with "Add to ID token" off).
 *
 * Returns null only when nothing could be read, which must not be confused
 * with "the claim is genuinely absent" — the caller skips the sync rather than
 * demoting a user because the IdP was briefly unreachable.
 */
async function resolveClaims(
	account: OidcAccount,
	oidc: OidcConfig & { adminClaim: string },
): Promise<Record<string, unknown> | null> {
	const idTokenClaims = account.idToken
		? decodeJwtPayload(account.idToken)
		: null;
	if (idTokenClaims && getClaim(idTokenClaims, oidc.adminClaim) !== undefined)
		return idTokenClaims;

	// The claim is not in the ID token. Ask the userinfo endpoint before
	// concluding the user has no groups. Without an access token there is
	// nothing else to consult, so the ID token stands.
	if (!account.accessToken) return idTokenClaims;

	// From here a lookup that cannot complete returns null rather than the
	// claimless ID token: "we could not check" must not read as "the user is
	// not an admin", or an unreachable IdP would demote every admin who signs
	// in during the outage.
	const endpoint = await getUserInfoEndpoint(oidc.discoveryUrl);
	if (!endpoint) return null;
	try {
		const response = await fetch(endpoint, {
			headers: { Authorization: `Bearer ${account.accessToken}` },
		});
		if (!response.ok) return null;
		const profile: unknown = await response.json();
		if (typeof profile !== "object" || profile === null) return null;
		if (Array.isArray(profile)) return null;
		return profile as Record<string, unknown>;
	} catch {
		return null;
	}
}

/**
 * Re-applies the admin role from the IdP's group claim after an OIDC sign-in,
 * so removing someone from the group at the IdP demotes them on next login.
 *
 * No-op unless both `OIDC_ADMIN_CLAIM` and `OIDC_ADMIN_VALUE` are set. Never
 * throws: this runs in an `after` hook where an exception would replace the
 * browser's success redirect with an error.
 */
export async function syncOidcRole(
	userId: string,
	context: OidcAuthContext,
): Promise<void> {
	const oidc = config.oidc;
	if (!oidc?.adminClaim || !oidc.adminValue) return;
	try {
		const accounts = await context.internalAdapter.findAccounts(userId);
		const account = accounts.find(
			(entry) => entry.providerId === OIDC_PROVIDER_ID,
		);
		if (!account) return;

		const claims = await resolveClaims(
			account,
			oidc as OidcConfig & { adminClaim: string },
		);
		if (!claims) {
			logger
				.withMetadata({ userId })
				.warn("oidc role sync skipped: no claims available");
			return;
		}

		const desired = roleFromClaims(claims, {
			adminClaim: oidc.adminClaim,
			adminValue: oidc.adminValue,
		});
		const current = sqlite
			.query("SELECT role, isDisabled FROM user WHERE id = ?")
			.get(userId) as { role: string; isDisabled: number } | null;
		if (!current || current.role === desired) return;

		if (
			desired === "user" &&
			current.role === "admin" &&
			!current.isDisabled &&
			countActiveAdmins() <= 1
		) {
			logger
				.withMetadata({ userId })
				.warn("oidc role sync kept the last active admin");
			return;
		}

		await applyUserRole(userId, desired);
		logger
			.withMetadata({ userId, role: desired })
			.info("oidc role sync applied");
	} catch (error) {
		logger.withError(error).error("oidc role sync failed");
	}
}
