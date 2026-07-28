import { afterEach, describe, expect, test } from "bun:test";
import { Database as BunDatabase } from "bun:sqlite";
import { Kysely } from "kysely";
import { BunSqliteDialect } from "kysely-bun-sqlite";
import { plainTextExchange } from "../fixtures";
import { up } from "../../db/migrations/020_chat_v2";
import { createV2TestDatabase } from "./fixtures";
import { ChatV2Repository, V2NotFoundError } from "./repository";

const USER_A = "user-a";
const USER_B = "user-b";

describe("chat-v2 database", () => {
	const databases: Awaited<ReturnType<typeof createV2TestDatabase>>[] = [];

	afterEach(async () => {
		await Promise.all(
			databases.splice(0).map((database) => database.destroy()),
		);
	});

	async function repositoryFixture() {
		const database = await createV2TestDatabase();
		databases.push(database);
		database.seedUser(USER_A);
		database.seedUser(USER_B);
		return { ...database, repository: new ChatV2Repository(database.db) };
	}

	test("migrates an empty database and passes SQLite integrity checks", async () => {
		const sqlite = new BunDatabase(":memory:");
		sqlite.exec("PRAGMA foreign_keys = ON;");
		const db = new Kysely({
			dialect: new BunSqliteDialect({ database: sqlite }),
		});
		await up(db);
		expect(sqlite.query("PRAGMA integrity_check").get()).toEqual({
			integrity_check: "ok",
		});
		expect(sqlite.query("PRAGMA foreign_key_check").all()).toEqual([]);
		await db.destroy();
		sqlite.close();
	});

	test("appends canonical messages in ordinal order and rejects duplicate ordinals", async () => {
		const { db, repository } = await repositoryFixture();
		const conversation = await repository.createConversation(USER_A, {
			id: "conversation-a",
			title: "Test conversation",
		});
		const exchange = plainTextExchange();
		const userMessage = exchange[0]!;
		const assistantMessage = exchange[1]!;
		const first = await repository.appendCanonicalMessages(
			USER_A,
			conversation.id,
			[
				{
					id: "message-1",
					message: userMessage,
					origin: "text",
					status: "complete",
				},
			],
		);
		const second = await repository.appendCanonicalMessages(
			USER_A,
			conversation.id,
			[
				{
					id: "message-2",
					message: assistantMessage,
					origin: "text",
					status: "complete",
				},
			],
		);
		expect([...first, ...second].map((message) => message.ordinal)).toEqual([
			0, 1,
		]);
		await expect(
			db
				.insertInto("v2_conversation_message")
				.values({
					id: "duplicate-ordinal",
					conversationId: conversation.id,
					turnId: null,
					ordinal: 1,
					role: "user",
					messageJson: JSON.stringify(userMessage),
					origin: "text",
					status: "complete",
					createdAt: new Date().toISOString(),
				})
				.execute(),
		).rejects.toThrow();
	});

	test("deletes a message suffix and cascades bindings and compactions", async () => {
		const { db, repository, sqlite } = await repositoryFixture();
		const conversation = await repository.createConversation(USER_A, {
			id: "conversation-a",
			title: "Test conversation",
		});
		const exchange = plainTextExchange();
		const userMessage = exchange[0]!;
		const assistantMessage = exchange[1]!;
		await repository.appendCanonicalMessages(USER_A, conversation.id, [
			{
				id: "message-1",
				message: userMessage,
				origin: "text",
				status: "complete",
			},
			{
				id: "message-2",
				message: assistantMessage,
				origin: "text",
				status: "complete",
			},
		]);
		await db
			.insertInto("v2_attachment")
			.values({
				id: "attachment-1",
				userId: USER_A,
				storageKey: "attachment-1",
				filename: "note.txt",
				mimeType: "text/plain",
				kind: "text",
				byteSize: 4,
				sha256: "hash",
				width: null,
				height: null,
				pageCount: null,
				createdAt: new Date().toISOString(),
			})
			.execute();
		await db
			.insertInto("v2_message_attachment")
			.values({
				messageId: "message-2",
				attachmentId: "attachment-1",
				ordinal: 0,
			})
			.execute();
		await db
			.insertInto("v2_context_compaction")
			.values({
				id: "compaction-1",
				conversationId: conversation.id,
				firstMessageId: "message-1",
				lastMessageId: "message-2",
				replacementMessagesJson: "[]",
				sourceHash: "hash",
				promptVersion: "v1",
				provider: null,
				api: null,
				model: null,
				tokensBefore: null,
				tokensAfter: null,
				createdAt: new Date().toISOString(),
			})
			.execute();
		await repository.deleteMessageSuffix(USER_A, conversation.id, 1);
		expect(
			await db.selectFrom("v2_conversation_message").select("id").execute(),
		).toEqual([{ id: "message-1" }]);
		expect(
			await db.selectFrom("v2_message_attachment").selectAll().execute(),
		).toEqual([]);
		expect(
			await db.selectFrom("v2_context_compaction").selectAll().execute(),
		).toEqual([]);
		expect(sqlite.query("PRAGMA integrity_check").get()).toEqual({
			integrity_check: "ok",
		});
		expect(sqlite.query("PRAGMA foreign_key_check").all()).toEqual([]);
	});

	test("finalizes a generation with its canonical messages atomically", async () => {
		const { db, repository } = await repositoryFixture();
		const conversation = await repository.createConversation(USER_A, {
			id: "conversation-a",
			title: "Test conversation",
		});
		await repository.createGeneration(USER_A, conversation.id, {
			id: "generation-1",
			status: "streaming",
			provider: "fixture",
			api: "openai-completions",
			model: "fixture-model",
			requestJson: "{}",
		});
		const assistantMessage = plainTextExchange()[1]!;
		await repository.finalizeGeneration(USER_A, "generation-1", {
			status: "complete",
			messages: [
				{
					id: "message-1",
					message: assistantMessage,
					origin: "text",
					status: "complete",
				},
			],
		});
		expect(
			await db.selectFrom("v2_conversation_message").select("id").execute(),
		).toEqual([{ id: "message-1" }]);
		expect(
			await db.selectFrom("v2_generation").select("status").execute(),
		).toEqual([{ status: "complete" }]);
	});

	test("rejects cross-user conversation, message, generation, attachment, and compaction access", async () => {
		const { db, repository } = await repositoryFixture();
		const conversation = await repository.createConversation(USER_A, {
			id: "conversation-a",
			title: "Test conversation",
		});
		await repository.createTurn(USER_A, conversation.id, {
			id: "turn-1",
			ordinal: 0,
			role: "user",
			origin: "text",
			status: "complete",
		});
		const userMessage = plainTextExchange()[0]!;
		await repository.appendCanonicalMessages(USER_A, conversation.id, [
			{
				id: "message-1",
				turnId: "turn-1",
				message: userMessage,
				origin: "text",
				status: "complete",
			},
		]);
		await repository.createGeneration(USER_A, conversation.id, {
			id: "generation-1",
			status: "pending",
			provider: "fixture",
			api: "openai-completions",
			model: "fixture-model",
			requestJson: "{}",
		});
		await db
			.insertInto("v2_attachment")
			.values({
				id: "attachment-1",
				userId: USER_A,
				storageKey: "attachment-1",
				filename: "note.txt",
				mimeType: "text/plain",
				kind: "text",
				byteSize: 4,
				sha256: "hash",
				width: null,
				height: null,
				pageCount: null,
				createdAt: new Date().toISOString(),
			})
			.execute();
		await db
			.insertInto("v2_context_compaction")
			.values({
				id: "compaction-1",
				conversationId: conversation.id,
				firstMessageId: "message-1",
				lastMessageId: "message-1",
				replacementMessagesJson: "[]",
				sourceHash: "hash",
				promptVersion: "v1",
				provider: null,
				api: null,
				model: null,
				tokensBefore: null,
				tokensAfter: null,
				createdAt: new Date().toISOString(),
			})
			.execute();
		await db
			.insertInto("v2_context_compaction_job")
			.values({
				id: "job-1",
				conversationId: conversation.id,
				firstMessageId: "message-1",
				lastMessageId: "message-1",
				sourceHash: "hash",
				status: "queued",
				compactionId: "compaction-1",
				errorMessage: null,
				createdAt: new Date().toISOString(),
				finishedAt: null,
			})
			.execute();
		for (const lookup of [
			() => repository.getConversation(USER_B, conversation.id),
			() => repository.getTurn(USER_B, "turn-1"),
			() => repository.getMessage(USER_B, "message-1"),
			() => repository.getGeneration(USER_B, "generation-1"),
			() => repository.getAttachment(USER_B, "attachment-1"),
			() => repository.getCompaction(USER_B, "compaction-1"),
			() => repository.getCompactionJob(USER_B, "job-1"),
		])
			await expect(lookup()).rejects.toBeInstanceOf(V2NotFoundError);
	});
});
