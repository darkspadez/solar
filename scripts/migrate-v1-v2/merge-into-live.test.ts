import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Database } from "bun:sqlite";
import { mergeIntoLive } from "./merge-into-live";

const paths: string[] = [];
afterEach(async () => {
	await Promise.all(
		paths.splice(0).map((path) => rm(path, { recursive: true, force: true })),
	);
});

async function migratedDb(): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "solar-merge-migrated-"));
	paths.push(root);
	const path = join(root, "migrated.db");
	const db = new Database(path);
	db.exec(
		"create table v2_conversation (id text primary key, userId text not null, title text not null, folderId text, provider text, endpointId text, modelId text, modelApi text, systemPrompt text, generationConfigJson text not null default '{}', createdAt text not null, updatedAt text not null);",
	);
	db.query(
		"insert into v2_conversation values (?, ?, ?, null, null, null, null, null, null, '{}', ?, ?)",
	).run(
		"c1",
		"u1",
		"Chat",
		"2025-01-01T00:00:00.000Z",
		"2025-01-01T00:00:00.000Z",
	);
	db.close();
	return path;
}

async function liveDb(
	options: { withV2Tables?: boolean; preSeeded?: boolean } = {},
): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "solar-merge-live-"));
	paths.push(root);
	const path = join(root, "live.db");
	const db = new Database(path);
	db.exec(
		"pragma foreign_keys=on; create table user (id text primary key, email text unique); create table conversation (id text primary key, userId text not null);",
	);
	db.query("insert into user values (?, ?)").run("u1", "one@example.test");
	db.query("insert into conversation values (?, ?)").run("v1-c1", "u1");
	if (options.withV2Tables) {
		db.exec(
			"create table v2_conversation (id text primary key, userId text not null, title text not null, folderId text, provider text, endpointId text, modelId text, modelApi text, systemPrompt text, generationConfigJson text not null default '{}', createdAt text not null, updatedAt text not null);",
		);
		for (const table of [
			"v2_folder",
			"v2_tag",
			"v2_conversation_turn",
			"v2_conversation_message",
			"v2_attachment",
			"v2_message_attachment",
			"v2_generation",
			"v2_generation_event",
			"v2_context_compaction",
			"v2_context_compaction_job",
			"v2_conversation_tag",
			"v2_voice_turn",
		])
			db.exec(`create table ${table} (id text primary key);`);
		if (options.preSeeded)
			db.query(
				"insert into v2_conversation values (?, ?, ?, null, null, null, null, null, null, '{}', ?, ?)",
			).run(
				"existing",
				"u1",
				"Existing",
				"2025-01-01T00:00:00.000Z",
				"2025-01-01T00:00:00.000Z",
			);
	}
	db.close();
	return path;
}

describe("merge migrated v2 data into a live database", () => {
	test("copies v2 rows into the live db while leaving v1 tables untouched", async () => {
		const migrated = await migratedDb();
		const live = await liveDb({ withV2Tables: true });
		const report = await mergeIntoLive({ migratedDb: migrated, liveDb: live });
		expect(report.tables.v2_conversation).toBe(1);
		expect(report.integrityCheck).toBe("ok");
		expect(report.foreignKeyCheck).toEqual([]);
		const db = new Database(live, { readonly: true });
		expect(
			(db.query("select count(*) as count from v2_conversation").get() as any)
				.count,
		).toBe(1);
		expect(
			(db.query("select count(*) as count from user").get() as any).count,
		).toBe(1);
		expect(
			(db.query("select count(*) as count from conversation").get() as any)
				.count,
		).toBe(1);
		db.close();
	});

	test("refuses to merge into a live db missing the v2 schema", async () => {
		const migrated = await migratedDb();
		const live = await liveDb({ withV2Tables: false });
		await expect(
			mergeIntoLive({ migratedDb: migrated, liveDb: live }),
		).rejects.toThrow(/missing table/);
	});

	test("refuses to merge into a live db that already has v2 data unless forced", async () => {
		const migrated = await migratedDb();
		const live = await liveDb({ withV2Tables: true, preSeeded: true });
		await expect(
			mergeIntoLive({ migratedDb: migrated, liveDb: live }),
		).rejects.toThrow(/already has rows/);
		const report = await mergeIntoLive({
			migratedDb: migrated,
			liveDb: live,
			force: true,
		});
		expect(report.integrityCheck).toBe("ok");
		const db = new Database(live, { readonly: true });
		expect(
			(db.query("select count(*) as count from v2_conversation").get() as any)
				.count,
		).toBe(2);
		db.close();
	});
});
