import { sql, type Kysely } from "kysely";

/**
 * Image workspaces are intentionally separate from chat-v2 and pi sessions.
 * Assets are immutable originals; attempts retain every provider request,
 * including failed and interrupted requests.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
	await db.schema
		.alterTable("provider_config")
		.addColumn("imageModels", "text", (col) => col.notNull().defaultTo("[]"))
		.execute();

	await db.schema
		.createTable("image_workspace")
		.addColumn("id", "text", (col) => col.primaryKey())
		.addColumn("userId", "text", (col) =>
			col.notNull().references("user.id").onDelete("cascade"),
		)
		.addColumn("title", "text", (col) => col.notNull())
		.addColumn("modelId", "text")
		.addColumn("aspectRatio", "text")
		.addColumn("resolution", "text")
		.addColumn("createdAt", "text", (col) =>
			col.notNull().defaultTo(sql`CURRENT_TIMESTAMP`),
		)
		.addColumn("updatedAt", "text", (col) =>
			col.notNull().defaultTo(sql`CURRENT_TIMESTAMP`),
		)
		.execute();

	await db.schema
		.createTable("image_asset")
		.addColumn("id", "text", (col) => col.primaryKey())
		.addColumn("userId", "text", (col) =>
			col.notNull().references("user.id").onDelete("cascade"),
		)
		.addColumn("workspaceId", "text", (col) =>
			col.notNull().references("image_workspace.id").onDelete("cascade"),
		)
		.addColumn("sourceAssetId", "text", (col) =>
			col.references("image_asset.id").onDelete("set null"),
		)
		.addColumn("kind", "text", (col) => col.notNull())
		.addColumn("filename", "text", (col) => col.notNull())
		.addColumn("mimeType", "text", (col) => col.notNull())
		.addColumn("byteSize", "integer", (col) => col.notNull())
		.addColumn("sha256", "text", (col) => col.notNull())
		.addColumn("width", "integer")
		.addColumn("height", "integer")
		.addColumn("storageKey", "text", (col) => col.notNull().unique())
		.addColumn("createdAt", "text", (col) =>
			col.notNull().defaultTo(sql`CURRENT_TIMESTAMP`),
		)
		.addCheckConstraint(
			"image_asset_kind_check",
			sql`kind in ('upload', 'generated')`,
		)
		.execute();

	await db.schema
		.createTable("image_attempt")
		.addColumn("id", "text", (col) => col.primaryKey())
		.addColumn("userId", "text", (col) =>
			col.notNull().references("user.id").onDelete("cascade"),
		)
		.addColumn("workspaceId", "text", (col) =>
			col.notNull().references("image_workspace.id").onDelete("cascade"),
		)
		.addColumn("sourceAssetId", "text", (col) =>
			col.references("image_asset.id").onDelete("set null"),
		)
		.addColumn("retryOfAttemptId", "text", (col) =>
			col.references("image_attempt.id").onDelete("set null"),
		)
		.addColumn("requestKey", "text", (col) => col.notNull())
		.addColumn("prompt", "text", (col) => col.notNull())
		.addColumn("provider", "text", (col) => col.notNull())
		.addColumn("endpointId", "text", (col) => col.notNull())
		.addColumn("api", "text", (col) => col.notNull())
		.addColumn("modelId", "text", (col) => col.notNull())
		.addColumn("aspectRatio", "text")
		.addColumn("resolution", "text")
		.addColumn("status", "text", (col) => col.notNull().defaultTo("queued"))
		.addColumn("errorMessage", "text")
		.addColumn("usageJson", "text")
		.addColumn("costMicros", "integer")
		.addColumn("resultAssetId", "text", (col) =>
			col.references("image_asset.id").onDelete("set null"),
		)
		.addColumn("createdAt", "text", (col) =>
			col.notNull().defaultTo(sql`CURRENT_TIMESTAMP`),
		)
		.addColumn("startedAt", "text")
		.addColumn("finishedAt", "text")
		.addCheckConstraint(
			"image_attempt_status_check",
			sql`status in ('queued', 'running', 'complete', 'failed', 'interrupted')`,
		)
		.execute();

	await db.schema
		.createIndex("image_workspace_userId_updatedAt_idx")
		.on("image_workspace")
		.columns(["userId", "updatedAt"])
		.execute();
	await db.schema
		.createIndex("image_asset_workspaceId_createdAt_idx")
		.on("image_asset")
		.columns(["workspaceId", "createdAt"])
		.execute();
	await db.schema
		.createIndex("image_attempt_workspaceId_createdAt_idx")
		.on("image_attempt")
		.columns(["workspaceId", "createdAt"])
		.execute();
	await db.schema
		.createIndex("image_attempt_sourceAssetId_idx")
		.on("image_attempt")
		.column("sourceAssetId")
		.execute();
	await db.schema
		.createIndex("image_attempt_workspace_requestKey_idx")
		.on("image_attempt")
		.columns(["workspaceId", "requestKey"])
		.unique()
		.execute();

	// SQLite has no portable conditional UNIQUE constraint. This makes the
	// attempt insert itself the atomic claim for a workspace's active slot.
	await sql`
		create unique index image_attempt_one_active_workspace_idx
		on image_attempt (workspaceId)
		where status in ('queued', 'running')
	`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
	await sql`drop index if exists image_attempt_one_active_workspace_idx`.execute(
		db,
	);
	await db.schema.dropTable("image_attempt").execute();
	await db.schema.dropTable("image_asset").execute();
	await db.schema.dropTable("image_workspace").execute();
	await db.schema
		.alterTable("provider_config")
		.dropColumn("imageModels")
		.execute();
}
