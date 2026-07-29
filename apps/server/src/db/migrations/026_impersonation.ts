import { type Kysely } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
	await db.schema
		.createTable("impersonation_session")
		.addColumn("adminSessionId", "text", (col) => col.primaryKey())
		.addColumn("targetUserId", "text", (col) => col.notNull())
		.addColumn("expiresAt", "integer", (col) => col.notNull())
		.addColumn("updatedAt", "integer", (col) => col.notNull())
		.execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
	await db.schema.dropTable("impersonation_session").execute();
}
