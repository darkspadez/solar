import { describe, expect, test } from "bun:test";

process.env.DATABASE_PATH = ":memory:";
delete process.env.OIDC_ISSUER;
delete process.env.OIDC_CLIENT_ID;
delete process.env.OIDC_CLIENT_SECRET;

const { accountIssuerFor } = await import("./accountIssuer");

describe("accountIssuerFor", () => {
	test("refuses to invent an OIDC issuer when the provider is not configured", () => {
		expect(() => accountIssuerFor("oidc")).toThrow(
			/OIDC_ISSUER, OIDC_CLIENT_ID, and OIDC_CLIENT_SECRET/,
		);
	});
});
