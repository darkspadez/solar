import { Database as BunDatabase } from "bun:sqlite";
import { Kysely, sql } from "kysely";
import { BunSqliteDialect } from "kysely-bun-sqlite";
import type { Database } from "../../db/schema";
import { up } from "../../db/migrations/020_chat_v2";
import { up as upOrganization } from "../../db/migrations/021_chat_v2_organization";
import { up as upVoice } from "../../db/migrations/022_chat_v2_voice";

export async function createV2TestDatabase(): Promise<{
	db: Kysely<Database>;
	sqlite: BunDatabase;
	seedUser(id: string): void;
	reset(): Promise<void>;
	destroy(): Promise<void>;
}> {
	const sqlite = new BunDatabase(":memory:");
	sqlite.exec("PRAGMA foreign_keys = ON;");
	const db = new Kysely<Database>({
		dialect: new BunSqliteDialect({ database: sqlite }),
	});
	await db.schema
		.createTable("user")
		.addColumn("id", "text", (col) => col.primaryKey())
		.execute();
	await up(db as unknown as Kysely<unknown>);
	await upOrganization(db as unknown as Kysely<unknown>);
	await upVoice(db as unknown as Kysely<unknown>);
	return {
		db,
		sqlite,
		seedUser(id) {
			sqlite.query("insert into user (id) values (?)").run(id);
		},
		async reset() {
			await db.deleteFrom("v2_conversation").execute();
			await db.deleteFrom("v2_attachment").execute();
			await sql`delete from user`.execute(db);
		},
		async destroy() {
			await db.destroy();
			sqlite.close();
		},
	};
}
