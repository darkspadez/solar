import { afterEach, describe, expect, test } from "bun:test";
import { Database as BunDatabase } from "bun:sqlite";
import { Kysely } from "kysely";
import { BunSqliteDialect } from "kysely-bun-sqlite";
import type { Database } from "../db/schema";
import { up } from "../db/migrations/027_images";
import { up as upMetadata } from "../db/migrations/028_image_attempt_metadata";
import {
	ImageConflictError,
	ImageNotFoundError,
	ImageRepository,
} from "./repository";
import type { ImageStorage } from "./storage";

const USER_A = "user-a";
const USER_B = "user-b";

function fakeStorage(): ImageStorage {
	const save: ImageStorage["save"] = async (
		workspaceId,
		assetId,
		bytes,
		mimeType,
	) => ({
		storageKey: `images/${workspaceId}/${assetId}`,
		mimeType,
		byteSize: bytes.byteLength,
		width: 1,
		height: 1,
		sha256: "hash",
	});
	const read: ImageStorage["read"] = async () => new Uint8Array([1]);
	const remove: ImageStorage["remove"] = async () => {};
	const removeWorkspace: ImageStorage["removeWorkspace"] = async () => {};
	return { save, read, remove, removeWorkspace } as unknown as ImageStorage;
}

async function createDatabase() {
	const sqlite = new BunDatabase(":memory:");
	sqlite.exec("PRAGMA foreign_keys = ON;");
	const database = new Kysely<Database>({
		dialect: new BunSqliteDialect({ database: sqlite }),
	});
	await database.schema
		.createTable("user")
		.addColumn("id", "text", (column) => column.primaryKey())
		.execute();
	await database.schema
		.createTable("provider_config")
		.addColumn("provider", "text", (column) => column.primaryKey())
		.addColumn("apiKey", "text")
		.addColumn("baseUrl", "text")
		.addColumn("endpoints", "text", (column) =>
			column.notNull().defaultTo("[]"),
		)
		.addColumn("enabledModels", "text", (column) =>
			column.notNull().defaultTo("[]"),
		)
		.addColumn("updatedAt", "text", (column) => column.notNull())
		.execute();
	sqlite.query("INSERT INTO user (id) VALUES (?), (?)").run(USER_A, USER_B);
	await up(database as unknown as Kysely<unknown>);
	await upMetadata(database as unknown as Kysely<unknown>);
	return { database, sqlite };
}

describe("image repository", () => {
	const databases: { database: Kysely<Database>; sqlite: BunDatabase }[] = [];

	afterEach(async () => {
		for (const { database, sqlite } of databases.splice(0)) {
			await database.destroy();
			sqlite.close();
		}
	});

	test("keeps workspaces private and claims only one active attempt", async () => {
		const fixture = await createDatabase();
		databases.push(fixture);
		const repository = new ImageRepository(fixture.database, fakeStorage());
		const workspace = await repository.createWorkspace(USER_A, {
			title: "Private image",
		});

		await expect(repository.get(USER_B, workspace.id)).rejects.toBeInstanceOf(
			ImageNotFoundError,
		);
		const first = await repository.createAttempt(USER_A, workspace.id, {
			requestKey: "request-a",
			prompt: "first",
			modelId: "image-model",
		});
		await expect(
			repository.createAttempt(USER_A, workspace.id, {
				requestKey: "request-b",
				prompt: "second",
				modelId: "image-model",
			}),
		).rejects.toBeInstanceOf(ImageConflictError);

		expect((await repository.claimAttempt(USER_A, first.id))?.status).toBe(
			"running",
		);
		expect(
			await repository.failAttempt(USER_A, first.id, "provider failed"),
		).toBe(true);
		const retry = await repository.createRetryAttempt(USER_A, first.id);
		expect(retry.retryOfAttemptId).toBe(first.id);
		expect((await repository.get(USER_A, workspace.id)).activeAttempt?.id).toBe(
			retry.id,
		);
	});
});
