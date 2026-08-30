import { sql, type Kysely } from "kysely";

/** Minimal v2-only organization metadata; canonical message JSON remains unchanged. */
export async function up(db: Kysely<unknown>): Promise<void> {
	await db.schema
		.createTable("v2_folder")
		.addColumn("id", "text", (col) => col.primaryKey())
		.addColumn("userId", "text", (col) =>
			col.notNull().references("user.id").onDelete("cascade"),
		)
		.addColumn("name", "text", (col) => col.notNull())
		.addColumn("createdAt", "text", (col) =>
			col.notNull().defaultTo(sql`CURRENT_TIMESTAMP`),
		)
		.execute();
	await db.schema
		.createTable("v2_tag")
		.addColumn("id", "text", (col) => col.primaryKey())
		.addColumn("userId", "text", (col) =>
			col.notNull().references("user.id").onDelete("cascade"),
		)
		.addColumn("name", "text", (col) => col.notNull())
		.addColumn("createdAt", "text", (col) =>
			col.notNull().defaultTo(sql`CURRENT_TIMESTAMP`),
		)
		.execute();
	await db.schema
		.alterTable("v2_conversation")
		.addColumn("folderId", "text", (col) =>
			col.references("v2_folder.id").onDelete("set null"),
		)
		.execute();
	await db.schema
		.createTable("v2_conversation_tag")
		.addColumn("conversationId", "text", (col) =>
			col.notNull().references("v2_conversation.id").onDelete("cascade"),
		)
		.addColumn("tagId", "text", (col) =>
			col.notNull().references("v2_tag.id").onDelete("cascade"),
		)
		.addPrimaryKeyConstraint("v2_conversation_tag_pk", [
			"conversationId",
			"tagId",
		])
		.execute();
	await db.schema
		.createIndex("v2_folder_userId_idx")
		.on("v2_folder")
		.column("userId")
		.execute();
	await db.schema
		.createIndex("v2_tag_userId_idx")
		.on("v2_tag")
		.column("userId")
		.execute();
	await db.schema
		.createIndex("v2_conversation_folderId_idx")
		.on("v2_conversation")
		.column("folderId")
		.execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
	await db.schema.dropTable("v2_conversation_tag").execute();
	await db.schema
		.alterTable("v2_conversation")
		.dropColumn("folderId")
		.execute();
	await db.schema.dropTable("v2_tag").execute();
	await db.schema.dropTable("v2_folder").execute();
}
