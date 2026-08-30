import type { Kysely } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
	await db.schema
		.alterTable("v2_conversation")
		.addColumn("reasoningSummary", "integer", (col) =>
			col.notNull().defaultTo(0),
		)
		.execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
	await db.schema
		.alterTable("v2_conversation")
		.dropColumn("reasoningSummary")
		.execute();
}
