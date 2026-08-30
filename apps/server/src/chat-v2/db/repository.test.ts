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

	test("resolves a user turn to the assistant turn that immediately follows it", async () => {
		const { repository } = await repositoryFixture();
		const conversation = await repository.createConversation(USER_A, {
			id: "conversation-b",
			title: "Test conversation",
		});
		await repository.createTurn(USER_A, conversation.id, {
			id: "user-turn",
			ordinal: 0,
			role: "user",
			origin: "text",
			status: "complete",
		});
		await repository.createTurn(USER_A, conversation.id, {
			id: "assistant-turn",
			ordinal: 1,
			role: "assistant",
			origin: "text",
			status: "complete",
		});
		expect(
			await repository.getAssistantTurnForUserTurn(USER_A, "user-turn"),
		).toMatchObject({ id: "assistant-turn" });
		await expect(
			repository.getAssistantTurnForUserTurn(USER_B, "user-turn"),
		).rejects.toBeInstanceOf(V2NotFoundError);
		await expect(
			repository.getAssistantTurnForUserTurn(USER_A, "assistant-turn"),
		).rejects.toBeInstanceOf(V2NotFoundError);
	});

	test("returns the canonical user message ID for attachment bindings", async () => {
		const { db, repository } = await repositoryFixture();
		const conversation = await repository.createConversation(USER_A, {
			id: "attachment-conversation",
			title: "Attachment conversation",
		});
		await repository.createAttachment(USER_A, {
			id: "attachment-1",
			storageKey: "attachment-1",
			filename: "note.txt",
			mimeType: "text/plain",
			kind: "text",
			byteSize: 4,
			sha256: "hash",
		});

		const started = await repository.startUserTurn(USER_A, conversation.id, {
			userTurnId: "user-turn",
			assistantTurnId: "assistant-turn",
			userMessage: {
				message: { role: "user", content: "note", timestamp: 1 },
				origin: "text",
				status: "complete",
			},
			attachmentIds: ["attachment-1"],
		});

		expect(started).toEqual({
			userTurnId: "user-turn",
			userMessageId: expect.any(String),
			assistantTurnId: "assistant-turn",
		});
		expect(
			await db.selectFrom("v2_message_attachment").selectAll().execute(),
		).toEqual([
			{
				messageId: started.userMessageId,
				attachmentId: "attachment-1",
				ordinal: 0,
			},
		]);
	});

	test("preserves pi-backed drafts while deleting empty drafts", async () => {
		const { repository } = await repositoryFixture();
		const persisted = await repository.createConversation(USER_A, {
			id: "persisted-conversation",
			title: "Persisted",
		});
		const abandoned = await repository.createConversation(USER_A, {
			id: "abandoned-conversation",
			title: "Abandoned",
		});

		await repository.deleteAbandonedConversations(USER_A, [persisted.id]);

		expect(
			(await repository.listConversations(USER_A)).map(
				(conversation) => conversation.id,
			),
		).toEqual([persisted.id]);
		await expect(
			repository.getConversation(USER_A, abandoned.id),
		).rejects.toBeInstanceOf(V2NotFoundError);
	});

	test("persists per-conversation model, effort, verbosity, display mode, and MCP settings", async () => {
		const { repository } = await repositoryFixture();
		const conversation = await repository.createConversation(USER_A, {
			title: "Settings",
		});

		await repository.setConversationModel(USER_A, conversation.id, {
			provider: "openai",
			endpointId: "openai-default",
			modelId: "gpt-5.6",
			modelApi: "openai-responses",
		});
		await repository.setConversationGenerationSettings(
			USER_A,
			conversation.id,
			{
				reasoningEffort: "high",
				verbosity: "low",
			},
		);
		await repository.setConversationDisplayMode(
			USER_A,
			conversation.id,
			"timeline",
		);
		await repository.setConversationAutoExecuteTools(
			USER_A,
			conversation.id,
			false,
		);

		const reloaded = await repository.getConversation(USER_A, conversation.id);
		expect(reloaded.provider).toBe("openai");
		expect(reloaded.endpointId).toBe("openai-default");
		expect(reloaded.modelId).toBe("gpt-5.6");
		expect(reloaded.modelApi).toBe("openai-responses");
		expect(reloaded.reasoningEffort).toBe("high");
		expect(reloaded.verbosity).toBe("low");
		expect(reloaded.displayMode).toBe("timeline");
		expect(reloaded.autoExecuteTools).toBe(0);

		// Partial updates leave previously set fields untouched.
		await repository.setConversationGenerationSettings(
			USER_A,
			conversation.id,
			{
				verbosity: "high",
			},
		);
		const afterPartialUpdate = await repository.getConversation(
			USER_A,
			conversation.id,
		);
		expect(afterPartialUpdate.reasoningEffort).toBe("high");
		expect(afterPartialUpdate.verbosity).toBe("high");

		// Ownership is enforced the same way as every other repository mutation.
		await expect(
			repository.setConversationModel(USER_B, conversation.id, {
				provider: "openai",
				endpointId: "openai-default",
				modelId: "gpt-5.6",
				modelApi: "openai-responses",
			}),
		).rejects.toBeInstanceOf(V2NotFoundError);
	});

	test("binds and lists MCP servers per conversation, isolated from other conversations", async () => {
		const { db, repository } = await repositoryFixture();
		const conversation = await repository.createConversation(USER_A, {
			title: "MCP",
		});
		const otherConversation = await repository.createConversation(USER_A, {
			title: "Other",
		});
		await db
			.insertInto("mcp_server")
			.values({
				id: "server-1",
				userId: null,
				name: "Shared server",
				url: "https://example.test/mcp",
				headers: "{}",
				enabled: 1,
				createdAt: new Date().toISOString(),
				updatedAt: new Date().toISOString(),
			})
			.execute();

		await repository.setConversationMcpServer(
			USER_A,
			conversation.id,
			"server-1",
			true,
		);
		expect(
			await repository.listConversationMcpServers(USER_A, conversation.id),
		).toEqual([{ serverId: "server-1", enabled: true }]);
		expect(
			await repository.listConversationMcpServers(USER_A, otherConversation.id),
		).toEqual([]);

		await repository.setConversationMcpServer(
			USER_A,
			conversation.id,
			"server-1",
			false,
		);
		expect(
			await repository.listConversationMcpServers(USER_A, conversation.id),
		).toEqual([{ serverId: "server-1", enabled: false }]);

		await expect(
			repository.listConversationMcpServers(USER_B, conversation.id),
		).rejects.toBeInstanceOf(V2NotFoundError);
	});
});
