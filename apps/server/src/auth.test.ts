import { describe, expect, test } from "bun:test";

process.env.DATABASE_PATH = ":memory:";
process.env.AUTH_ALLOWED_DOMAINS = "example.com";

const { auth } = await import("./auth");

const validateUserInfo = auth.options.user?.validateUserInfo;

function oidcIdentity(email: string) {
	return {
		user: { email },
		source: {
			action: "link-account" as const,
			method: "oauth" as const,
			oauth: { providerId: "oidc", profile: {} },
		},
	};
}

describe("OIDC email-domain validation", () => {
	test("rejects an out-of-policy identity before account linking", async () => {
		expect(validateUserInfo).toBeFunction();
		expect(
			await validateUserInfo?.(oidcIdentity("person@outside.example")),
		).toEqual({
			error: "EMAIL_DOMAIN_NOT_ALLOWED",
			errorDescription: "Email domain is not allowed",
		});
	});

	test("allows an in-policy OIDC identity", async () => {
		expect(
			await validateUserInfo?.(oidcIdentity("person@example.com")),
		).toBeUndefined();
	});

	test("leaves non-OIDC identities to their existing validation paths", async () => {
		expect(
			await validateUserInfo?.({
				...oidcIdentity("person@outside.example"),
				source: {
					action: "link-account",
					method: "oauth",
					oauth: { providerId: "google", profile: {} },
				},
			}),
		).toBeUndefined();
	});
});
