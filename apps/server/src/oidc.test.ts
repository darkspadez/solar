import { beforeEach, describe, expect, mock, test } from "bun:test";
import type { OidcConfig } from "./config";

let oidcConfig: OidcConfig | null = null;
let userRow: { role: string; isDisabled: number } | null = null;
let activeAdmins = 2;
const roleWrites: { userId: string; role: string }[] = [];

mock.module("./config", () => ({
	config: {
		get oidc() {
			return oidcConfig;
		},
	},
}));
mock.module("./db", () => ({
	db: {},
	sqlite: { query: () => ({ get: () => userRow }) },
}));
mock.module("./userRoles", () => ({
	countActiveAdmins: () => activeAdmins,
	applyUserRole: async (userId: string, role: string) => {
		roleWrites.push({ userId, role });
	},
}));
const noop = () => {};
const chain = {
	withMetadata: () => chain,
	withError: () => chain,
	info: noop,
	warn: noop,
	error: noop,
};
mock.module("./logger", () => ({ logger: chain }));

const {
	buildOidcProviderConfig,
	claimContains,
	decodeJwtPayload,
	getClaim,
	oauthCallbackPathIsRegistered,
	OIDC_PROVIDER_ID,
	resetOidcDiscoveryCache,
	roleFromClaims,
	syncOidcRole,
} = await import("./oidc");

function baseConfig(overrides: Partial<OidcConfig> = {}): OidcConfig {
	return {
		issuer: "https://auth.example.com/",
		discoveryUrl: "https://auth.example.com/.well-known/openid-configuration",
		clientId: "solar",
		clientSecret: "secret",
		displayName: "Keycloak",
		scopes: ["openid", "profile", "email"],
		disableSignUp: false,
		adminClaim: "groups",
		adminValue: "solar-admins",
		...overrides,
	};
}

function idToken(claims: Record<string, unknown>): string {
	return `header.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.signature`;
}

function contextWith(account: Record<string, unknown> | null) {
	const normalized =
		account?.providerId === OIDC_PROVIDER_ID
			? { issuer: baseConfig().issuer, ...account }
			: account;
	return {
		internalAdapter: {
			findAccounts: async () =>
				normalized ? [normalized as never] : ([] as never[]),
		},
	};
}

function contextWithAccounts(accounts: Record<string, unknown>[]) {
	return {
		internalAdapter: {
			findAccounts: async () => accounts as never[],
		},
	};
}

describe("decodeJwtPayload", () => {
	test("reads the claims of a well-formed token", () => {
		expect(decodeJwtPayload(idToken({ sub: "1", groups: ["a"] }))).toEqual({
			sub: "1",
			groups: ["a"],
		});
	});

	test("returns null for anything it cannot read", () => {
		expect(decodeJwtPayload("not-a-jwt")).toBeNull();
		expect(decodeJwtPayload("header..signature")).toBeNull();
		expect(
			decodeJwtPayload(
				`header.${Buffer.from("[1,2]").toString("base64url")}.sig`,
			),
		).toBeNull();
	});
});

describe("getClaim", () => {
	test("prefers a literal key so colons and dots in names survive", () => {
		const zitadel = "urn:zitadel:iam:org:project:roles";
		expect(getClaim({ [zitadel]: { admin: {} } }, zitadel)).toEqual({
			admin: {},
		});
		expect(getClaim({ "a.b": "literal", a: { b: "nested" } }, "a.b")).toBe(
			"literal",
		);
	});

	test("walks a dotted path", () => {
		expect(
			getClaim(
				{ realm_access: { roles: ["solar-admins"] } },
				"realm_access.roles",
			),
		).toEqual(["solar-admins"]);
	});

	test("is undefined when the path is missing", () => {
		expect(getClaim({}, "groups")).toBeUndefined();
		expect(
			getClaim({ realm_access: null }, "realm_access.roles"),
		).toBeUndefined();
	});
});

describe("claimContains", () => {
	test("matches an array of groups", () => {
		expect(claimContains(["users", "solar-admins"], "solar-admins")).toBe(true);
		expect(claimContains(["users"], "solar-admins")).toBe(false);
	});

	test("matches an object keyed by role name", () => {
		expect(
			claimContains({ "solar-admins": { org: "1" } }, "solar-admins"),
		).toBe(true);
		expect(claimContains({ other: {} }, "solar-admins")).toBe(false);
	});

	test("matches a single or delimited string", () => {
		expect(claimContains("solar-admins", "solar-admins")).toBe(true);
		expect(claimContains("users solar-admins", "solar-admins")).toBe(true);
		expect(claimContains("users,solar-admins", "solar-admins")).toBe(true);
		expect(claimContains("solar-admins-extra", "solar-admins")).toBe(false);
	});

	test("is case-sensitive and rejects other shapes", () => {
		expect(claimContains(["Solar-Admins"], "solar-admins")).toBe(false);
		expect(claimContains(undefined, "solar-admins")).toBe(false);
		expect(claimContains(42, "solar-admins")).toBe(false);
	});
});

describe("roleFromClaims", () => {
	const options = { adminClaim: "groups", adminValue: "solar-admins" };

	test("grants admin when the claim carries the value", () => {
		expect(roleFromClaims({ groups: ["solar-admins"] }, options)).toBe("admin");
	});

	test("treats a missing claim as a plain user", () => {
		expect(roleFromClaims({}, options)).toBe("user");
		expect(roleFromClaims({ groups: [] }, options)).toBe("user");
	});
});

describe("buildOidcProviderConfig", () => {
	test("enables PKCE and pins the account issuer without mapping the profile", () => {
		const built = buildOidcProviderConfig(baseConfig());
		expect(built.providerId).toBe(OIDC_PROVIDER_ID);
		expect(built.pkce).toBe(true);
		// Pinned so a discovery outage cannot abort provider initialization,
		// and so account.issuer stays predictable for the 1.7 backfill.
		expect(built.accountIssuer).toBe("https://auth.example.com/");
		expect(built.disableSignUp).toBe(false);
		expect(built).not.toHaveProperty("mapProfileToUser");
		expect(built).not.toHaveProperty("overrideUserInfo");
	});
});

describe("oauthCallbackPathIsRegistered", () => {
	test("recognises the route the role-sync hook matches", () => {
		expect(oauthCallbackPathIsRegistered(["/callback/:id", "/ok"])).toBe(true);
	});

	test("reports a route that upstream has renamed", () => {
		// The 1.6 path. Returning false here is what makes the next rename loud
		// instead of silently freezing admin roles.
		expect(
			oauthCallbackPathIsRegistered(["/oauth2/callback/:providerId"]),
		).toBe(false);
	});
});

describe("syncOidcRole", () => {
	const originalFetch = globalThis.fetch;

	beforeEach(() => {
		oidcConfig = baseConfig();
		userRow = { role: "user", isDisabled: 0 };
		activeAdmins = 2;
		roleWrites.length = 0;
		globalThis.fetch = originalFetch;
		resetOidcDiscoveryCache();
	});

	test("promotes a user whose token carries the admin group", async () => {
		await syncOidcRole(
			"u1",
			contextWith({
				providerId: OIDC_PROVIDER_ID,
				idToken: idToken({ groups: ["solar-admins"] }),
			}),
		);

		expect(roleWrites).toEqual([{ userId: "u1", role: "admin" }]);
	});

	test("demotes an admin who lost the group", async () => {
		userRow = { role: "admin", isDisabled: 0 };
		await syncOidcRole(
			"u1",
			contextWith({
				providerId: OIDC_PROVIDER_ID,
				idToken: idToken({ groups: ["users"] }),
			}),
		);

		expect(roleWrites).toEqual([{ userId: "u1", role: "user" }]);
	});

	test("keeps the last active admin", async () => {
		userRow = { role: "admin", isDisabled: 0 };
		activeAdmins = 1;
		await syncOidcRole(
			"u1",
			contextWith({
				providerId: OIDC_PROVIDER_ID,
				idToken: idToken({ groups: ["users"] }),
			}),
		);

		expect(roleWrites).toEqual([]);
	});

	test("writes nothing when the role already matches", async () => {
		userRow = { role: "admin", isDisabled: 0 };
		await syncOidcRole(
			"u1",
			contextWith({
				providerId: OIDC_PROVIDER_ID,
				idToken: idToken({ groups: ["solar-admins"] }),
			}),
		);

		expect(roleWrites).toEqual([]);
	});

	test("does nothing when role mapping is not configured", async () => {
		oidcConfig = baseConfig({ adminClaim: undefined, adminValue: undefined });
		await syncOidcRole(
			"u1",
			contextWith({
				providerId: OIDC_PROVIDER_ID,
				idToken: idToken({ groups: ["solar-admins"] }),
			}),
		);

		expect(roleWrites).toEqual([]);
	});

	test("ignores users with no OIDC account", async () => {
		await syncOidcRole("u1", contextWith({ providerId: "google" }));

		expect(roleWrites).toEqual([]);
	});

	test("falls back to userinfo when the claim is absent from the token", async () => {
		const seen: string[] = [];
		const requestOptions: (RequestInit | undefined)[] = [];
		globalThis.fetch = (async (
			input: string | URL | Request,
			init?: RequestInit,
		) => {
			const url = String(input);
			seen.push(url);
			requestOptions.push(init);
			if (url.endsWith("/.well-known/openid-configuration"))
				return Response.json({
					userinfo_endpoint: "https://auth.example.com/userinfo",
				});
			expect((init?.headers as Record<string, string>).Authorization).toBe(
				"Bearer at",
			);
			return Response.json({ groups: ["solar-admins"] });
		}) as unknown as typeof fetch;

		await syncOidcRole(
			"u1",
			contextWith({
				providerId: OIDC_PROVIDER_ID,
				idToken: idToken({ sub: "1" }),
				accessToken: "at",
			}),
		);

		expect(seen).toEqual([
			"https://auth.example.com/.well-known/openid-configuration",
			"https://auth.example.com/userinfo",
		]);
		expect(requestOptions).toHaveLength(2);
		for (const options of requestOptions) {
			expect(options?.redirect).toBe("error");
			expect(options?.signal).toBeInstanceOf(AbortSignal);
		}
		expect(roleWrites).toEqual([{ userId: "u1", role: "admin" }]);
	});

	test.each([
		"http://auth.example.com/userinfo",
		"file:///tmp/userinfo",
		"not a URL",
	])(
		"does not send an access token to an unsafe userinfo URL: %s",
		async (endpoint) => {
			const seen: string[] = [];
			globalThis.fetch = (async (input: string | URL | Request) => {
				seen.push(String(input));
				return Response.json({ userinfo_endpoint: endpoint });
			}) as unknown as typeof fetch;

			await syncOidcRole(
				"u1",
				contextWith({
					providerId: OIDC_PROVIDER_ID,
					idToken: idToken({ sub: "1" }),
					accessToken: "must-not-leak",
				}),
			);

			expect(seen).toEqual([
				"https://auth.example.com/.well-known/openid-configuration",
			]);
			expect(roleWrites).toEqual([]);
		},
	);

	test("uses only the account belonging to the configured issuer", async () => {
		await syncOidcRole(
			"u1",
			contextWithAccounts([
				{
					providerId: OIDC_PROVIDER_ID,
					issuer: "https://old-idp.example.com/",
					idToken: idToken({ groups: ["solar-admins"] }),
				},
				{
					providerId: OIDC_PROVIDER_ID,
					issuer: baseConfig().issuer,
					idToken: idToken({ groups: ["users"] }),
				},
			]),
		);

		expect(roleWrites).toEqual([]);
	});

	test("demotes when userinfo answers without the group", async () => {
		userRow = { role: "admin", isDisabled: 0 };
		globalThis.fetch = (async (input: string | URL | Request) =>
			String(input).endsWith("/.well-known/openid-configuration")
				? Response.json({
						userinfo_endpoint: "https://auth.example.com/userinfo",
					})
				: Response.json({ groups: ["users"] })) as unknown as typeof fetch;

		await syncOidcRole(
			"u1",
			contextWith({
				providerId: OIDC_PROVIDER_ID,
				idToken: idToken({ sub: "1" }),
				accessToken: "at",
			}),
		);

		expect(roleWrites).toEqual([{ userId: "u1", role: "user" }]);
	});

	test("does not demote when the userinfo lookup cannot complete", async () => {
		userRow = { role: "admin", isDisabled: 0 };
		globalThis.fetch = (async () => {
			throw new Error("unreachable");
		}) as unknown as typeof fetch;

		await syncOidcRole(
			"u1",
			contextWith({
				providerId: OIDC_PROVIDER_ID,
				idToken: idToken({ sub: "1" }),
				accessToken: "at",
			}),
		);

		expect(roleWrites).toEqual([]);
	});

	test("does not demote when userinfo returns an error status", async () => {
		userRow = { role: "admin", isDisabled: 0 };
		globalThis.fetch = (async (input: string | URL | Request) =>
			String(input).endsWith("/.well-known/openid-configuration")
				? Response.json({
						userinfo_endpoint: "https://auth.example.com/userinfo",
					})
				: new Response("nope", { status: 503 })) as unknown as typeof fetch;

		await syncOidcRole(
			"u1",
			contextWith({
				providerId: OIDC_PROVIDER_ID,
				idToken: idToken({ sub: "1" }),
				accessToken: "at",
			}),
		);

		expect(roleWrites).toEqual([]);
	});

	test("swallows adapter failures so the sign-in redirect survives", async () => {
		const context = {
			internalAdapter: {
				findAccounts: async () => {
					throw new Error("database is gone");
				},
			},
		};

		expect(await syncOidcRole("u1", context)).toBeUndefined();
		expect(roleWrites).toEqual([]);
	});
});
