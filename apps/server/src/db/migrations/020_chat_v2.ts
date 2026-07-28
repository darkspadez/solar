import { sql, type Kysely } from "kysely";

/**
 * Chat V2 uses namespaced tables in the existing SQLite database. This keeps
 * Better Auth's user table available for ownership foreign keys without
 * overlapping any v1 application table.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
	await db.schema
		.createTable("v2_conversation")
		.addColumn("id", "text", (col) => col.primaryKey())
		.addColumn("userId", "text", (col) =>
			col.notNull().references("user.id").onDelete("cascade"),
		)
		.addColumn("title", "text", (col) => col.notNull())
		.addColumn("provider", "text")
		.addColumn("endpointId", "text")
		.addColumn("modelId", "text")
		.addColumn("modelApi", "text")
		.addColumn("systemPrompt", "text")
		.addColumn("generationConfigJson", "text", (col) =>
			col.notNull().defaultTo("{}"),
		)
		.addColumn("createdAt", "text", (col) =>
			col.notNull().defaultTo(sql`CURRENT_TIMESTAMP`),
		)
		.addColumn("updatedAt", "text", (col) =>
			col.notNull().defaultTo(sql`CURRENT_TIMESTAMP`),
		)
		.execute();
	await db.schema
		.createIndex("v2_conversation_userId_idx")
		.on("v2_conversation")
		.column("userId")
		.execute();

	await db.schema
		.createTable("v2_conversation_turn")
		.addColumn("id", "text", (col) => col.primaryKey())
		.addColumn("conversationId", "text", (col) =>
			col.notNull().references("v2_conversation.id").onDelete("cascade"),
		)
		.addColumn("ordinal", "integer", (col) => col.notNull())
		.addColumn("role", "text", (col) => col.notNull())
		.addColumn("origin", "text", (col) => col.notNull())
		.addColumn("status", "text", (col) => col.notNull())
		.addColumn("createdAt", "text", (col) =>
			col.notNull().defaultTo(sql`CURRENT_TIMESTAMP`),
		)
		.addUniqueConstraint("v2_conversation_turn_conversation_ordinal_unique", [
			"conversationId",
			"ordinal",
		])
		.addCheckConstraint(
			"v2_conversation_turn_role_check",
			sql`role in ('user', 'assistant')`,
		)
		.execute();

	await db.schema
		.createTable("v2_conversation_message")
		.addColumn("id", "text", (col) => col.primaryKey())
		.addColumn("conversationId", "text", (col) =>
			col.notNull().references("v2_conversation.id").onDelete("cascade"),
		)
		.addColumn("turnId", "text", (col) =>
			col.references("v2_conversation_turn.id").onDelete("cascade"),
		)
		.addColumn("ordinal", "integer", (col) => col.notNull())
		.addColumn("role", "text", (col) => col.notNull())
		.addColumn("messageJson", "text", (col) => col.notNull())
		.addColumn("origin", "text", (col) => col.notNull())
		.addColumn("status", "text", (col) => col.notNull())
		.addColumn("createdAt", "text", (col) =>
			col.notNull().defaultTo(sql`CURRENT_TIMESTAMP`),
		)
		.addUniqueConstraint(
			"v2_conversation_message_conversation_ordinal_unique",
			["conversationId", "ordinal"],
		)
		.addCheckConstraint(
			"v2_conversation_message_role_check",
			sql`role in ('user', 'assistant', 'toolResult')`,
		)
		.execute();
	await db.schema
		.createIndex("v2_conversation_message_conversation_ordinal_idx")
		.on("v2_conversation_message")
		.columns(["conversationId", "ordinal"])
		.execute();
	await db.schema
		.createIndex("v2_conversation_message_turn_ordinal_idx")
		.on("v2_conversation_message")
		.columns(["turnId", "ordinal"])
		.execute();

	await db.schema
		.createTable("v2_attachment")
		.addColumn("id", "text", (col) => col.primaryKey())
		.addColumn("userId", "text", (col) =>
			col.notNull().references("user.id").onDelete("cascade"),
		)
		.addColumn("storageKey", "text", (col) => col.notNull().unique())
		.addColumn("filename", "text", (col) => col.notNull())
		.addColumn("mimeType", "text", (col) => col.notNull())
		.addColumn("kind", "text", (col) => col.notNull())
		.addColumn("byteSize", "integer", (col) => col.notNull())
		.addColumn("sha256", "text", (col) => col.notNull())
		.addColumn("width", "integer")
		.addColumn("height", "integer")
		.addColumn("pageCount", "integer")
		.addColumn("createdAt", "text", (col) =>
			col.notNull().defaultTo(sql`CURRENT_TIMESTAMP`),
		)
		.execute();

	await db.schema
		.createTable("v2_message_attachment")
		.addColumn("messageId", "text", (col) =>
			col
				.notNull()
				.references("v2_conversation_message.id")
				.onDelete("cascade"),
		)
		.addColumn("attachmentId", "text", (col) =>
			col.notNull().references("v2_attachment.id").onDelete("cascade"),
		)
		.addColumn("ordinal", "integer", (col) => col.notNull())
		.addPrimaryKeyConstraint("v2_message_attachment_pk", [
			"messageId",
			"attachmentId",
		])
		.addUniqueConstraint("v2_message_attachment_message_ordinal_unique", [
			"messageId",
			"ordinal",
		])
		.execute();

	await db.schema
		.createTable("v2_generation")
		.addColumn("id", "text", (col) => col.primaryKey())
		.addColumn("conversationId", "text", (col) =>
			col.notNull().references("v2_conversation.id").onDelete("cascade"),
		)
		.addColumn("turnId", "text", (col) =>
			col.references("v2_conversation_turn.id").onDelete("set null"),
		)
		.addColumn("status", "text", (col) => col.notNull())
		.addColumn("provider", "text", (col) => col.notNull())
		.addColumn("api", "text", (col) => col.notNull())
		.addColumn("model", "text", (col) => col.notNull())
		.addColumn("requestJson", "text", (col) => col.notNull())
		.addColumn("contextManifestJson", "text")
		.addColumn("partialMessageJson", "text")
		.addColumn("usageJson", "text")
		.addColumn("stopReason", "text")
		.addColumn("errorMessage", "text")
		.addColumn("startedAt", "text")
		.addColumn("finishedAt", "text")
		.addColumn("createdAt", "text", (col) =>
			col.notNull().defaultTo(sql`CURRENT_TIMESTAMP`),
		)
		.execute();

	await db.schema
		.createTable("v2_generation_event")
		.addColumn("generationId", "text", (col) =>
			col.notNull().references("v2_generation.id").onDelete("cascade"),
		)
		.addColumn("sequence", "integer", (col) => col.notNull())
		.addColumn("kind", "text", (col) => col.notNull())
		.addColumn("payloadJson", "text", (col) => col.notNull())
		.addColumn("createdAt", "text", (col) =>
			col.notNull().defaultTo(sql`CURRENT_TIMESTAMP`),
		)
		.addPrimaryKeyConstraint("v2_generation_event_pk", [
			"generationId",
			"sequence",
		])
		.execute();

	await db.schema
		.createTable("v2_context_compaction")
		.addColumn("id", "text", (col) => col.primaryKey())
		.addColumn("conversationId", "text", (col) =>
			col.notNull().references("v2_conversation.id").onDelete("cascade"),
		)
		.addColumn("firstMessageId", "text", (col) =>
			col
				.notNull()
				.references("v2_conversation_message.id")
				.onDelete("cascade"),
		)
		.addColumn("lastMessageId", "text", (col) =>
			col
				.notNull()
				.references("v2_conversation_message.id")
				.onDelete("cascade"),
		)
		.addColumn("replacementMessagesJson", "text", (col) => col.notNull())
		.addColumn("sourceHash", "text", (col) => col.notNull())
		.addColumn("promptVersion", "text", (col) => col.notNull())
		.addColumn("provider", "text")
		.addColumn("api", "text")
		.addColumn("model", "text")
		.addColumn("tokensBefore", "integer")
		.addColumn("tokensAfter", "integer")
		.addColumn("createdAt", "text", (col) =>
			col.notNull().defaultTo(sql`CURRENT_TIMESTAMP`),
		)
		.execute();

	await db.schema
		.createTable("v2_context_compaction_job")
		.addColumn("id", "text", (col) => col.primaryKey())
		.addColumn("conversationId", "text", (col) =>
			col.notNull().references("v2_conversation.id").onDelete("cascade"),
		)
		.addColumn("firstMessageId", "text", (col) => col.notNull())
		.addColumn("lastMessageId", "text", (col) => col.notNull())
		.addColumn("sourceHash", "text", (col) => col.notNull())
		.addColumn("status", "text", (col) => col.notNull())
		.addColumn("compactionId", "text", (col) =>
			col.references("v2_context_compaction.id").onDelete("set null"),
		)
		.addColumn("errorMessage", "text")
		.addColumn("createdAt", "text", (col) =>
			col.notNull().defaultTo(sql`CURRENT_TIMESTAMP`),
		)
		.addColumn("finishedAt", "text")
		.execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
	await db.schema.dropTable("v2_context_compaction_job").execute();
	await db.schema.dropTable("v2_context_compaction").execute();
	await db.schema.dropTable("v2_generation_event").execute();
	await db.schema.dropTable("v2_generation").execute();
	await db.schema.dropTable("v2_message_attachment").execute();
	await db.schema.dropTable("v2_attachment").execute();
	await db.schema.dropTable("v2_conversation_message").execute();
	await db.schema.dropTable("v2_conversation_turn").execute();
	await db.schema.dropTable("v2_conversation").execute();
}
