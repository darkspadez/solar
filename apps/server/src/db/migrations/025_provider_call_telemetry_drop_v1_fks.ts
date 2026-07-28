import { sql, type Kysely } from "kysely";

/**
 * `provider_call_telemetry.conversationId`/`messageId` were originally
 * foreign keys into the v1 `conversation`/`message` tables. Now that v2 is
 * the only chat implementation, every insert uses v2 conversation/turn ids,
 * which don't exist in those v1 tables — with `PRAGMA foreign_keys = ON`
 * (set at server startup), every telemetry insert has been silently failing
 * with `SQLITE_CONSTRAINT_FOREIGNKEY` since the v1 removal, so context/usage
 * metrics never populate for any conversation. SQLite can't drop a
 * constraint via `ALTER TABLE`, so the table is rebuilt without the FKs.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
	await db.schema
		.createTable("provider_call_telemetry_new")
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
	await sql`insert into provider_call_telemetry_new select * from provider_call_telemetry`.execute(
		db,
	);
	await db.schema.dropTable("provider_call_telemetry").execute();
	await db.schema
		.alterTable("provider_call_telemetry_new")
		.renameTo("provider_call_telemetry")
		.execute();
	await db.schema
		.createIndex("provider_call_telemetry_conversationId_idx")
		.on("provider_call_telemetry")
		.column("conversationId")
		.execute();
}

export async function down(): Promise<void> {
	throw new Error("provider_call_telemetry FK removal is not reversible");
}
