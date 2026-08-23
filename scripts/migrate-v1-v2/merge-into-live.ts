// Standalone offline tool. Never imported by the production server.
//
// Imports the `v2_*` rows produced by `migrate-history-v1-to-v2.ts` (a
// standalone, isolated target database) into a copy of the real, live
// `solar.db` — the same database the server actually reads from when
// `SOLAR_CHAT_V2=1`. `runMigration` alone is not sufficient for a production
// cutover: it writes to a brand-new file containing only a copy of the `user`
// table plus the `v2_*` tables, not the full application database (auth
// sessions, settings, presets, skills, MCP servers, etc.).
//
// This tool must be run against a copy of the live database, never the
// original file directly. It refuses to run against a live-db whose target
// v2_* tables are not already empty, unless --force is passed.
import { Database } from "bun:sqlite";

export type MergeOptions = {
	migratedDb: string;
	liveDb: string;
	force?: boolean;
};

export type MergeReport = {
	tables: Record<string, number>;
	preExisting: Record<string, number>;
	integrityCheck: string;
	foreignKeyCheck: unknown[];
};

// Dependency order: parents before children.
const V2_TABLES = [
	"v2_folder",
	"v2_tag",
	"v2_conversation",
	"v2_conversation_turn",
	"v2_conversation_message",
	"v2_attachment",
	"v2_message_attachment",
	"v2_generation",
	"v2_generation_event",
	"v2_context_compaction",
	"v2_context_compaction_job",
	"v2_conversation_tag",
	"v2_voice_turn",
] as const;

function tableExists(db: Database, table: string): boolean {
	return Boolean(
		db
			.query("select name from sqlite_master where type='table' and name=?")
			.get(table),
	);
}

function columns(db: Database, table: string): string[] {
	return (
		db.query(`pragma table_info("${table}")`).all() as { name: string }[]
	).map((row) => row.name);
}

function rowCount(db: Database, table: string): number {
	return (
		db.query(`select count(*) as count from "${table}"`).get() as {
			count: number;
		}
	).count;
}

export async function mergeIntoLive(
	options: MergeOptions,
): Promise<MergeReport> {
	const migrated = new Database(options.migratedDb, { readonly: true });
	const live = new Database(options.liveDb);
	live.exec("PRAGMA foreign_keys = ON");

	try {
		for (const table of V2_TABLES) {
			if (!tableExists(live, table))
				throw new Error(
					`live database is missing table ${table}; run the chat-v2 migrations (020-022) against it before merging`,
				);
		}

		const preExisting: Record<string, number> = {};
		for (const table of V2_TABLES) preExisting[table] = rowCount(live, table);
		const nonEmpty = V2_TABLES.filter((table) => preExisting[table] > 0);
		if (nonEmpty.length && !options.force)
			throw new Error(
				`live database already has rows in ${nonEmpty.join(", ")}; refusing to merge without --force`,
			);

		const inserted: Record<string, number> = {};
		live.exec("BEGIN");
		try {
			for (const table of V2_TABLES) {
				if (!tableExists(migrated, table)) {
					inserted[table] = 0;
					continue;
				}
				const cols = columns(migrated, table);
				const placeholders = cols.map(() => "?").join(", ");
				const insert = live.query(
					`insert into "${table}" (${cols.map((c) => `"${c}"`).join(", ")}) values (${placeholders})`,
				);
				const rows = migrated.query(`select * from "${table}"`).all() as Record<
					string,
					unknown
				>[];
				for (const row of rows) insert.run(...cols.map((c) => row[c]));
				inserted[table] = rows.length;
			}
			live.exec("COMMIT");
		} catch (error) {
			live.exec("ROLLBACK");
			throw error;
		}

		const integrityCheck = (
			live.query("PRAGMA integrity_check").get() as { integrity_check: string }
		).integrity_check;
		const foreignKeyCheck = live.query("PRAGMA foreign_key_check").all();

		return { tables: inserted, preExisting, integrityCheck, foreignKeyCheck };
	} finally {
		migrated.close();
		live.close();
	}
}

if (import.meta.main) {
	function value(name: string): string {
		const index = Bun.argv.indexOf(name);
		const result = Bun.argv[index + 1];
		if (index < 0 || !result || result.startsWith("--"))
			throw new Error(`missing ${name}`);
		return result;
	}
	const report = await mergeIntoLive({
		migratedDb: value("--migrated-db"),
		liveDb: value("--live-db"),
		force: Bun.argv.includes("--force"),
	});
	console.log(JSON.stringify(report, null, 2));
	if (report.integrityCheck !== "ok" || report.foreignKeyCheck.length)
		process.exitCode = 1;
}
