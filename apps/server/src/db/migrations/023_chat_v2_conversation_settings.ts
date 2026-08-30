import type { Kysely } from "kysely";

/**
 * Extends v2 conversations with the per-conversation settings that only ever
 * existed on the v1 `conversation` table (model/effort/verbosity/tool
 * auto-execution/display mode), plus a v2-native MCP server binding table.
 * Without these, conversations created after the chat-v2 rollout have no
 * place to persist model selection, reasoning effort, verbosity, or MCP
 * tool configuration.
 *
 * `v2_conversation_mcp_server` references the shared `mcp_server` table
 * directly (the same table v1 uses) rather than duplicating it, matching how
 * `v2_conversation.userId` already references the shared `user` table: MCP
 * server definitions are user-level infrastructure, not conversation
 * history, so there is nothing v2-specific about them.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
	await db.schema
		.alterTable("v2_conversation")
		.addColumn("reasoningEffort", "text")
		.execute();
	await db.schema
		.alterTable("v2_conversation")
		.addColumn("verbosity", "text")
		.execute();
	await db.schema
		.alterTable("v2_conversation")
		.addColumn("autoExecuteTools", "integer", (col) =>
			col.notNull().defaultTo(1),
		)
		.execute();
	await db.schema
		.alterTable("v2_conversation")
		.addColumn("displayMode", "text")
		.execute();

	await db.schema
		.createTable("v2_conversation_mcp_server")
		.addColumn("conversationId", "text", (col) =>
			col.notNull().references("v2_conversation.id").onDelete("cascade"),
		)
		.addColumn("serverId", "text", (col) =>
			col.notNull().references("mcp_server.id").onDelete("cascade"),
		)
		.addColumn("enabled", "integer", (col) => col.notNull().defaultTo(1))
		.addPrimaryKeyConstraint("v2_conversation_mcp_server_pk", [
			"conversationId",
			"serverId",
		])
		.execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
	await db.schema.dropTable("v2_conversation_mcp_server").execute();
	await db.schema
		.alterTable("v2_conversation")
		.dropColumn("displayMode")
		.execute();
	await db.schema
		.alterTable("v2_conversation")
		.dropColumn("autoExecuteTools")
		.execute();
	await db.schema
		.alterTable("v2_conversation")
		.dropColumn("verbosity")
		.execute();
	await db.schema
		.alterTable("v2_conversation")
		.dropColumn("reasoningEffort")
		.execute();
}
