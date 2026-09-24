import { sql, type Kysely } from "kysely";

async function columnNames(
	db: Kysely<unknown>,
	table: string,
): Promise<Set<string>> {
	const result = await sql<{
		name: string;
	}>`pragma table_info(${sql.raw(table)})`.execute(db);
	return new Set(result.rows.map((row) => row.name));
}

export async function up(db: Kysely<unknown>): Promise<void> {
	const providerColumns = await columnNames(db, "provider_config");
	if (!providerColumns.has("imageModels")) {
		await db.schema
			.alterTable("provider_config")
			.addColumn("imageModels", "text", (col) => col.notNull().defaultTo("[]"))
			.execute();
	}

	const attemptColumns = await columnNames(db, "image_attempt");
	if (!attemptColumns.has("requestKey")) {
		await db.schema
			.alterTable("image_attempt")
			.addColumn("requestKey", "text", (col) => col.notNull().defaultTo(""))
			.execute();
	}
	if (!attemptColumns.has("provider")) {
		await db.schema
			.alterTable("image_attempt")
			.addColumn("provider", "text", (col) =>
				col.notNull().defaultTo("openrouter"),
			)
			.execute();
	}
	if (!attemptColumns.has("endpointId")) {
		await db.schema
			.alterTable("image_attempt")
			.addColumn("endpointId", "text", (col) =>
				col.notNull().defaultTo("openrouter-images"),
			)
			.execute();
	}
	if (!attemptColumns.has("api")) {
		await db.schema
			.alterTable("image_attempt")
			.addColumn("api", "text", (col) =>
				col.notNull().defaultTo("openrouter-images"),
			)
			.execute();
	}

	await sql`
		create unique index if not exists image_attempt_workspace_requestKey_idx
		on image_attempt (workspaceId, requestKey)
		where requestKey <> ''
	`.execute(db);
}

export async function down(): Promise<void> {
	throw new Error("Image attempt metadata migration is not reversible");
}
