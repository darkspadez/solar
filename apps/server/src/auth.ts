import { betterAuth, type BetterAuthPlugin } from "better-auth";
import { APIError, createAuthMiddleware } from "better-auth/api";
import { genericOAuth } from "better-auth/plugins";
import { apiKey } from "@better-auth/api-key";
import {
	CREDENTIAL_ACCOUNT_ISSUER,
	CREDENTIAL_PROVIDER_ID,
} from "./accountIssuer";
import { config } from "./config";
import { dialect, sqlite } from "./db";
import { getSolarImpersonation } from "./impersonation";
import {
	buildOidcProviderConfig,
	OAUTH_CALLBACK_PATH,
	OIDC_PROVIDER_ID,
	syncOidcRole,
} from "./oidc";

export const API_KEY_HEADER = "x-api-key";

interface EmailDomainValidationError {
	error: "EMAIL_DOMAIN_NOT_ALLOWED";
	errorDescription: string;
}

/** Returns the browser-safe rejection details when an email violates policy. */
function emailDomainValidationError(
	email: unknown,
): EmailDomainValidationError | undefined {
	const allowed = config.allowedEmailDomains;
	if (allowed.length === 0) return;
	const domain =
		typeof email === "string" ? email.split("@").at(-1)?.toLowerCase() : null;
	if (!domain || !allowed.includes(domain)) {
		return {
			error: "EMAIL_DOMAIN_NOT_ALLOWED",
			errorDescription: "Email domain is not allowed",
		};
	}
}

/** Throws unless the email's domain is on the (optional) allowlist. */
function assertAllowedEmailDomain(email: string): void {
	const rejection = emailDomainValidationError(email);
	if (rejection) {
		// The OAuth callback turns a thrown error into a redirect only when the
		// body carries a `code`. Without one the browser is left on the callback
		// URL showing raw JSON instead of the sign-in page.
		throw new APIError("FORBIDDEN", {
			code: rejection.error,
			message: rejection.errorDescription,
		});
	}
}

/**
 * Better Auth instance. It uses its own Kysely adapter over the *same* SQLite
 * dialect/connection as the app (see `db/index.ts`), so auth tables and app
 * tables co-locate in one `solar.db`. Better Auth owns and migrates its own
 * tables (`user`, `session`, `account`, `verification`).
 *
 * Email addresses are the account identity. Google accounts with a verified
 * matching email are linked to an existing email/password account.
 */
export const auth = betterAuth({
	database: { dialect, type: "sqlite" },
	secret: config.authSecret,
	baseURL: config.authBaseURL,
	trustedOrigins:
		process.env.NODE_ENV !== "production" ? ["*"] : [config.authBaseURL],
	emailAndPassword: { enabled: true },
	...(!config.airgapMode && config.googleClientId && config.googleClientSecret
		? {
				socialProviders: {
					google: {
						clientId: config.googleClientId,
						clientSecret: config.googleClientSecret,
						disableSignUp: true,
						// Enforce the email-domain allowlist on every Google sign-in
						// (including linking to existing users). The profile email comes
						// from Google's signed ID token, so it can be trusted.
						mapProfileToUser: (profile) => {
							assertAllowedEmailDomain(profile.email);
							return {};
						},
					},
				},
			}
		: {}),
	account: {
		accountLinking: {
			enabled: true,
			trustedProviders: ["google", OIDC_PROVIDER_ID],
			allowDifferentEmails: false,
			// This app has no local email-verification flow, so email/password
			// accounts are never marked verified. Without this opt-out, Better Auth
			// refuses to implicitly link a Google or OIDC sign-in to an existing
			// local account. Trusting these providers by name is what allows the
			// link; the identity anchor is the matching email address, since
			// `allowDifferentEmails` stays off.
			requireLocalEmailVerified: false,
		},
	},
	plugins: [
		apiKey({
			apiKeyHeaders: API_KEY_HEADER,
			defaultPrefix: "sk_solar_",
			requireName: true,
			keyExpiration: {
				defaultExpiresIn: null,
				disableCustomExpiresTime: true,
			},
			rateLimit: { enabled: false },
			enableSessionForAPIKeys: true,
		}) as unknown as BetterAuthPlugin,
		// Optional self-hosted identity provider. Since 1.7 it adds no routes of
		// its own and rides the built-in social endpoints, `/sign-in/social` and
		// `/callback/:id`, both covered by the `/api/auth/*` GET+POST forward in
		// `index.ts`.
		...(config.oidc
			? [genericOAuth({ config: [buildOidcProviderConfig(config.oidc)] })]
			: []),
	],
	user: {
		// Generic OAuth invokes this before create, link, and returning sign-in.
		// Returning structured details lets its callback preserve the readable
		// redirect instead of converting a thrown hook error to validation_failed.
		validateUserInfo: ({ user, source }) => {
			if (source.oauth?.providerId !== OIDC_PROVIDER_ID) return;
			return emailDomainValidationError(user.email);
		},
		additionalFields: {
			// Admin/user roles (full enforcement + admin UI land in M4). Assigned by
			// the server, never accepted from client input.
			role: { type: "string", defaultValue: "user", input: false },
			isDisabled: { type: "boolean", defaultValue: false, input: false },
		},
	},
	// Re-apply the admin role from the IdP's group claim after every OIDC
	// sign-in. It cannot live in the provider's `mapProfileToUser`: fields it
	// returns are filtered against the user schema and `role` is `input: false`,
	// so the value would be dropped. By the time this runs the account row holds
	// a fresh ID token and the session exists.
	//
	// `/callback/:id` is the shared OAuth callback, so Google arrives here too;
	// the provider id is what selects OIDC sign-ins.
	...(config.oidc?.adminClaim
		? {
				hooks: {
					after: createAuthMiddleware(async (ctx) => {
						if (ctx.path !== OAUTH_CALLBACK_PATH) return;
						if (ctx.params?.id !== OIDC_PROVIDER_ID) return;
						const newSession = ctx.context.newSession;
						if (!newSession) return;
						await syncOidcRole(newSession.user.id, ctx.context);
					}),
				},
			}
		: {}),
	databaseHooks: {
		user: {
			create: {
				// First account to register on a deployment becomes the admin.
				before: async (user) => {
					// Covers email/password registration as a final persistence-layer
					// guard. Google and OIDC are checked earlier in their provider flows.
					assertAllowedEmailDomain(user.email);
					const row = sqlite.query("SELECT COUNT(*) AS c FROM user").get() as {
						c: number;
					};
					const role = row.c === 0 ? "admin" : "user";
					return { data: { ...user, role } };
				},
			},
		},
		session: {
			create: {
				before: async (session) => {
					const user = sqlite
						.query("SELECT isDisabled FROM user WHERE id = ?")
						.get(session.userId) as { isDisabled: number } | null;
					if (user?.isDisabled) {
						// The OAuth callback only converts a thrown error into a
						// redirect when the body carries a `code`; without one a
						// disabled user would be stranded on the callback URL
						// looking at raw JSON.
						throw new APIError("FORBIDDEN", {
							code: "ACCOUNT_DISABLED",
							message: "This account is disabled",
						});
					}
				},
			},
		},
	},
});

export async function getSolarSession(headers: Headers) {
	let session: Awaited<ReturnType<typeof auth.api.getSession>>;
	try {
		session = await auth.api.getSession({ headers });
	} catch {
		return null;
	}
	if (!session) return null;
	let effectiveUserId = session.user.id;
	let impersonation: {
		adminUserId: string;
		targetUserId: string;
		targetName: string;
		targetEmail: string;
	} | null = null;
	const activeImpersonation = getSolarImpersonation(session.session.id);
	if (activeImpersonation) {
		effectiveUserId = activeImpersonation.targetUserId;
	}
	const user = sqlite
		.query("SELECT id, name, email, role, isDisabled FROM user WHERE id = ?")
		.get(effectiveUserId) as {
		id: string;
		name: string;
		email: string;
		role: string;
		isDisabled: number;
	} | null;
	if (
		!user ||
		user.isDisabled ||
		(headers.has(API_KEY_HEADER) && user.role !== "admin")
	)
		return null;
	if (
		activeImpersonation &&
		effectiveUserId === activeImpersonation.targetUserId
	) {
		impersonation = {
			adminUserId: session.user.id,
			targetUserId: user.id,
			targetName: user.name,
			targetEmail: user.email,
		};
	}
	return {
		session: session.session,
		user: { ...session.user, ...user, role: user.role },
		impersonation,
	};
}

interface ApiKeyApi {
	createApiKey(input: {
		body: { name: string; userId: string };
	}): Promise<{ id: string; key: string }>;
}

export function createSolarApiKey(name: string, userId: string) {
	return (auth.api as unknown as ApiKeyApi).createApiKey({
		body: { name, userId },
	});
}

export function createSolarUser(input: {
	name: string;
	email: string;
	password: string;
}) {
	return auth.api.signUpEmail({ body: input });
}

export async function setSolarUserPassword(
	userId: string,
	newPassword: string,
): Promise<boolean> {
	const context = await auth.$context;
	if (!(await context.internalAdapter.findUserById(userId))) return false;

	const hashedPassword = await context.password.hash(newPassword);
	const credentialAccount = (
		await context.internalAdapter.findAccounts(userId)
	).find((account) => account.providerId === "credential");
	if (credentialAccount) {
		await context.internalAdapter.updatePassword(userId, hashedPassword);
	} else {
		await context.internalAdapter.createAccount({
			userId,
			providerId: CREDENTIAL_PROVIDER_ID,
			issuer: CREDENTIAL_ACCOUNT_ISSUER,
			accountId: userId,
			password: hashedPassword,
		});
	}
	return true;
}
