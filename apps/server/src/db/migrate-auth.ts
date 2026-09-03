import { getMigrations } from "better-auth/db/migration";
import { accountIssuerFor } from "../accountIssuer";
import { auth } from "../auth";
import { logger } from "../logger";
import { sqlite } from "./index";

/** Returns a table's current columns, or an empty list before it exists. */
function columnNames(table: string): string[] {
	const columns = sqlite.query(`PRAGMA table_info(${table})`).all() as {
		name: string;
	}[];
	return columns.map((column) => column.name);
}

/** Matches the index better-auth creates on a fresh 1.7 database. */
const ACCOUNT_ISSUER_INDEX = "account_issuer_accountId_uidx";

/**
 * Recreates the `(issuer, accountId)` unique index on an upgraded database.
 *
 * Better Auth only emits schema changes for missing tables and columns, so once
 * the backfill below has added the column its generator has nothing left to do
 * and never creates this index. Without it an upgraded deployment would quietly
 * run without the uniqueness guarantee a fresh install gets.
 */
function ensureAccountIssuerIndex(): void {
	const existing = sqlite
		.query("SELECT name FROM sqlite_master WHERE type = 'index' AND name = ?")
		.get(ACCOUNT_ISSUER_INDEX);
	if (existing) return;
	try {
		sqlite.exec(
			`CREATE UNIQUE INDEX "${ACCOUNT_ISSUER_INDEX}" ON "account" ("issuer", "accountId")`,
		);
		logger.info(`created ${ACCOUNT_ISSUER_INDEX}`);
	} catch (error) {
		// Only reachable if the table already holds two rows for one external
		// identity. Authentication must not start without its identity constraint.
		logger
			.withError(error)
			.error(
				`could not create ${ACCOUNT_ISSUER_INDEX}; resolve duplicate (issuer, accountId) rows in the account table`,
			);
		throw error;
	}
}

/**
 * Adds and backfills `account.issuer`, introduced as a required column in
 * Better Auth 1.7 together with a unique index on `(issuer, accountId)`.
 *
 * Better Auth's generator cannot add a NOT NULL column to a table that already
 * has rows, and it never backfills values, so this runs first. Without it every
 * existing sign-in breaks.
 */
function backfillAccountIssuer(): void {
	const columns = columnNames("account");
	// No table yet: better-auth creates it complete, index included.
	if (columns.length === 0) return;

	if (!columns.includes("issuer")) {
		sqlite.exec(
			"ALTER TABLE account ADD COLUMN issuer TEXT NOT NULL DEFAULT ''",
		);
	}

	// Run on every startup so an interruption after ALTER TABLE cannot strand
	// rows at the temporary empty default and break identity lookup permanently.
	const providers = sqlite
		.query("SELECT DISTINCT providerId FROM account WHERE issuer = ''")
		.all() as { providerId: string }[];
	const update = sqlite.query(
		"UPDATE account SET issuer = ? WHERE providerId = ? AND issuer = ''",
	);
	for (const { providerId } of providers) {
		update.run(accountIssuerFor(providerId), providerId);
	}
	if (providers.length > 0) {
		logger
			.withMetadata({
				providers: providers.map((row) => row.providerId),
			})
			.info("backfilled account.issuer for better-auth 1.7");
	}

	ensureAccountIssuerIndex();
}

/**
 * Runs Better Auth's own table migrations against the shared `solar.db`. Better
 * Auth is a separate migration owner from our Kysely migrations; both run at
 * startup so the single DB is fully provisioned.
 */
export async function migrateAuth(): Promise<void> {
	const userColumns = columnNames("user");
	if (userColumns.length > 0 && !userColumns.includes("isDisabled")) {
		sqlite.exec(
			"ALTER TABLE user ADD COLUMN isDisabled INTEGER NOT NULL DEFAULT 0",
		);
	}
	backfillAccountIssuer();
	const { toBeCreated, toBeAdded, runMigrations } = await getMigrations(
		auth.options,
	);
	if (toBeCreated.length === 0 && toBeAdded.length === 0) return;
	await runMigrations();
	logger.info("better-auth migrations applied");
}

if (import.meta.main) {
	await migrateAuth();
	logger.info("auth migrations up to date");
	process.exit(0);
}
