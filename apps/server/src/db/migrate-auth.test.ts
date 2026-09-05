import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { Database } from "bun:sqlite";

const sqlite = new Database(":memory:");
const loggedErrors: unknown[] = [];

mock.module("better-auth/db/migration", () => ({
	getMigrations: async () => ({
		toBeCreated: [],
		toBeAdded: [],
		runMigrations: async () => {},
	}),
}));
mock.module("../accountIssuer", () => ({
	accountIssuerFor: (providerId: string) => `issuer:${providerId}`,
}));
mock.module("../auth", () => ({ auth: { options: {} } }));
mock.module("../logger", () => {
	const chain = {
		withError: (error: unknown) => {
			loggedErrors.push(error);
			return chain;
		},
		withMetadata: () => chain,
		info: () => {},
		error: () => {},
	};
	return { logger: chain };
});
mock.module("./index", () => ({ sqlite }));

const { migrateAuth } = await import("./migrate-auth");

describe("Better Auth issuer migration", () => {
	beforeEach(() => {
		sqlite.exec("DROP TABLE IF EXISTS account; DROP TABLE IF EXISTS user;");
		loggedErrors.length = 0;
	});

	afterAll(() => sqlite.close());

	test("resumes backfilling rows left empty after the issuer column was added", async () => {
		sqlite.exec(`
			CREATE TABLE account (
				id TEXT PRIMARY KEY,
				providerId TEXT NOT NULL,
				accountId TEXT NOT NULL,
				issuer TEXT NOT NULL DEFAULT ''
			);
			INSERT INTO account (id, providerId, accountId, issuer)
			VALUES
				('a1', 'credential', 'u1', 'issuer:credential'),
				('a2', 'google', 'subject-2', '');
		`);

		await migrateAuth();

		expect(
			sqlite.query("SELECT issuer FROM account WHERE id = 'a2'").get(),
		).toEqual({ issuer: "issuer:google" });
		expect(
			sqlite
				.query(
					"SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'account_issuer_accountId_uidx'",
				)
				.get(),
		).toEqual({ name: "account_issuer_accountId_uidx" });
	});

	test("fails migration when duplicate identities prevent the unique index", async () => {
		sqlite.exec(`
			CREATE TABLE account (
				id TEXT PRIMARY KEY,
				providerId TEXT NOT NULL,
				accountId TEXT NOT NULL,
				issuer TEXT NOT NULL
			);
			INSERT INTO account (id, providerId, accountId, issuer)
			VALUES
				('a1', 'google', 'subject-1', 'issuer:google'),
				('a2', 'google', 'subject-1', 'issuer:google');
		`);

		await expect(migrateAuth()).rejects.toThrow(/UNIQUE constraint failed/);
		expect(loggedErrors).toHaveLength(1);
	});
});
