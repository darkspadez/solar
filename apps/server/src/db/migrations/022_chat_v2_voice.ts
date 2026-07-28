import { sql, type Kysely } from "kysely";

/** Realtime voice metadata and callback idempotency remain outside canonical pi-ai messages. */
export async function up(db: Kysely<unknown>): Promise<void> {
	await db.schema
		.createTable("v2_voice_turn")
		.addColumn("turnKey", "text", (col) => col.primaryKey())
		.addColumn("conversationId", "text", (col) =>
			col.notNull().references("v2_conversation.id").onDelete("cascade"),
		)
		.addColumn("userTurnId", "text", (col) =>
			col.notNull().references("v2_conversation_turn.id").onDelete("cascade"),
		)
		.addColumn("assistantTurnId", "text", (col) =>
			col.notNull().references("v2_conversation_turn.id").onDelete("cascade"),
		)
		.addColumn("generationId", "text", (col) =>
			col.notNull().references("v2_generation.id").onDelete("cascade"),
		)
		.addColumn("metadataJson", "text", (col) => col.notNull().defaultTo("{}"))
		.addColumn("createdAt", "text", (col) =>
			col.notNull().defaultTo(sql`CURRENT_TIMESTAMP`),
		)
		.execute();
	await db.schema
		.createIndex("v2_voice_turn_conversationId_idx")
		.on("v2_voice_turn")
		.column("conversationId")
		.execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
	await db.schema.dropTable("v2_voice_turn").execute();
}
