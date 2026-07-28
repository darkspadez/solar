import { Database as BunDatabase } from "bun:sqlite";
import { Kysely, sql } from "kysely";
import { BunSqliteDialect } from "kysely-bun-sqlite";
import type { Database } from "../../db/schema";
import { up } from "../../db/migrations/020_chat_v2";
import { up as upOrganization } from "../../db/migrations/021_chat_v2_organization";
import { up as upVoice } from "../../db/migrations/022_chat_v2_voice";
import { up as upSettings } from "../../db/migrations/023_chat_v2_conversation_settings";
import { up as upReasoningSummary } from "../../db/migrations/024_chat_v2_reasoning_summary";
import { up as upSkills } from "../../db/migrations/018_skills";

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
	await db.schema
		.createTable("mcp_server")
		.addColumn("id", "text", (col) => col.primaryKey())
		.addColumn("userId", "text")
		.addColumn("name", "text", (col) => col.notNull())
		.addColumn("url", "text", (col) => col.notNull())
		.addColumn("headers", "text", (col) => col.notNull().defaultTo("{}"))
		.addColumn("enabled", "integer", (col) => col.notNull().defaultTo(1))
		.addColumn("createdAt", "text", (col) => col.notNull())
		.addColumn("updatedAt", "text", (col) => col.notNull())
		.execute();
	await db.schema
		.createTable("user_mcp_server_preference")
		.addColumn("userId", "text", (col) => col.notNull())
		.addColumn("serverId", "text", (col) =>
			col.notNull().references("mcp_server.id").onDelete("cascade"),
		)
		.addColumn("enabled", "integer", (col) => col.notNull().defaultTo(1))
		.addPrimaryKeyConstraint("user_mcp_server_preference_pk", [
			"userId",
			"serverId",
		])
		.execute();
	// Post-025 shape (no FKs into the removed v1 conversation/message tables).
	await db.schema
		.createTable("provider_call_telemetry")
		.addColumn("id", "text", (col) => col.primaryKey())
		.addColumn("conversationId", "text")
		.addColumn("messageId", "text")
		.addColumn("provider", "text", (col) => col.notNull())
		.addColumn("api", "text", (col) => col.notNull())
		.addColumn("modelId", "text", (col) => col.notNull())
		.addColumn("purpose", "text", (col) => col.notNull())
		.addColumn("inputTokens", "integer")
		.addColumn("outputTokens", "integer")
		.addColumn("cacheReadTokens", "integer")
		.addColumn("cacheWriteTokens", "integer")
		.addColumn("estimatedCostMicros", "integer")
		.addColumn("latencyMs", "integer")
		.addColumn("contextPolicySource", "text")
		.addColumn("contextPolicyEnabled", "integer")
		.addColumn("contextPolicyState", "text")
		.addColumn("overflowed", "integer", (col) => col.notNull().defaultTo(0))
		.addColumn("retryAttempt", "integer", (col) => col.notNull().defaultTo(0))
		.addColumn("compactionTokensBefore", "integer")
		.addColumn("compactionTokensAfter", "integer")
		.addColumn("createdAt", "text", (col) =>
			col.notNull().defaultTo(sql`CURRENT_TIMESTAMP`),
		)
		.execute();
	await up(db as unknown as Kysely<unknown>);
	await upOrganization(db as unknown as Kysely<unknown>);
	await upVoice(db as unknown as Kysely<unknown>);
	await upSettings(db as unknown as Kysely<unknown>);
	await upReasoningSummary(db as unknown as Kysely<unknown>);
	await upSkills(db as unknown as Kysely<unknown>);
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
