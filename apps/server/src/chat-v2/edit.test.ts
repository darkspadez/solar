import { afterEach, describe, expect, test } from "bun:test";
import type { AssistantMessage, Message, UserMessage } from "@earendil-works/pi-ai";
import { createV2TestDatabase } from "./db/fixtures";
import { ChatV2Repository, V2NotFoundError, V2StaleTargetError } from "./db/repository";
import { ChatV2EditService } from "./edit";
import { plainTextExchange } from "./fixtures";
import { loadCanonicalHistory } from "./history";
import type { CanonicalMessageStatus, VisibleTurnRole } from "./types";

const USER_ID = "edit-user";
const CONVERSATION_ID = "edit-conversation";

const generation = (id: string) => ({
	id,
	provider: "fixture",
	api: "openai-completions",
	model: "fixture-model",
	request: { messages: [] },
});

describe("chat-v2 destructive edit and regenerate", () => {
	const databases: Awaited<ReturnType<typeof createV2TestDatabase>>[] = [];

	afterEach(async () => {
		await Promise.all(databases.splice(0).map((database) => database.destroy()));
	});

	async function setup() {
		const database = await createV2TestDatabase();
		databases.push(database);
		database.seedUser(USER_ID);
		const repository = new ChatV2Repository(database.db);
		await repository.createConversation(USER_ID, {
			id: CONVERSATION_ID,
			title: "Destructive edits",
		});
		const [firstUser, assistant] = plainTextExchange() as [UserMessage, AssistantMessage];
		const secondUser: UserMessage = { role: "user", content: "Second question", timestamp: 3 };
		const secondAssistant: AssistantMessage = {
			...assistant,
			content: [{ type: "text", text: "Second answer" }],
			timestamp: 4,
		};
		const turns: [string, VisibleTurnRole, CanonicalMessageStatus][] = [
			["user-1", "user", "complete"],
			["assistant-1", "assistant", "complete"],
			["user-2", "user", "complete"],
			["assistant-2", "assistant", "complete"],
		];
		for (const [ordinal, [id, role, status]] of turns.entries())
			await repository.createTurn(USER_ID, CONVERSATION_ID, {
				id,
				ordinal,
				role,
				origin: "text",
				status,
			});
		const messages: Message[] = [firstUser, assistant, secondUser, secondAssistant];
		await repository.appendCanonicalMessages(USER_ID, CONVERSATION_ID, messages.map((message, ordinal) => ({
			id: `message-${ordinal + 1}`,
			turnId: ordinal === 0 ? "user-1" : ordinal === 1 ? "assistant-1" : ordinal === 2 ? "user-2" : "assistant-2",
			message,
			origin: "text" as const,
			status: "complete" as const,
		})));
		for (const [id, turnId, status] of [
			["generation-1", "assistant-1", "complete"],
			["generation-2", "assistant-2", "running"],
		] as const)
			await repository.createGeneration(USER_ID, CONVERSATION_ID, {
				id,
				turnId,
				status,
				provider: "fixture",
				api: "openai-completions",
				model: "fixture-model",
				requestJson: "{}",
			});
		return { database, repository, assistant };
	}

	test("editing a user turn replaces its suffix and starts a new assistant generation", async () => {
		const { database, repository } = await setup();
		database.sqlite.exec("create table message (id text primary key, text text not null)");
		database.sqlite.query("insert into message values (?, ?)").run("v1-message", "unchanged");
		const service = new ChatV2EditService(repository);
		const replacement: UserMessage = { role: "user", content: "Edited question", timestamp: 99 };
		const result = await service.editUserMessage({
			userId: USER_ID,
			conversationId: CONVERSATION_ID,
			targetTurnId: "user-1",
			message: replacement,
			userTurnId: "edited-user",
			assistantTurnId: "edited-assistant",
			generation: generation("edited-generation"),
		});
		expect(result).toMatchObject({ assistantTurnId: "edited-assistant", generationId: "edited-generation" });
		expect(await loadCanonicalHistory(repository, USER_ID, CONVERSATION_ID)).toEqual([replacement]);
		expect(await repository.getGeneration(USER_ID, "edited-generation")).toMatchObject({
			turnId: "edited-assistant",
			status: "running",
		});
		await expect(repository.getGeneration(USER_ID, "generation-2")).rejects.toBeInstanceOf(V2NotFoundError);
		expect(database.sqlite.query("select * from message").all()).toEqual([
			{ id: "v1-message", text: "unchanged" },
		]);
	});

	test("regenerating an assistant deletes its response and all later history", async () => {
		const { database, repository, assistant } = await setup();
		database.sqlite.exec("create table message (id text primary key, text text not null)");
		database.sqlite.query("insert into message values (?, ?)").run("v1-message", "unchanged");
		const service = new ChatV2EditService(repository);
		await service.regenerateAssistantTurn({
			userId: USER_ID,
			conversationId: CONVERSATION_ID,
			targetTurnId: "assistant-1",
			assistantTurnId: "regenerated-assistant",
			generation: generation("regenerated-generation"),
		});
		expect(await loadCanonicalHistory(repository, USER_ID, CONVERSATION_ID)).toEqual([
			plainTextExchange()[0]!,
		]);
		expect(await repository.getGeneration(USER_ID, "regenerated-generation")).toMatchObject({
			turnId: "regenerated-assistant",
			status: "running",
		});
		expect(assistant.content).toEqual([{ type: "text", text: "Hi." }]);
		expect(database.sqlite.query("select * from message").all()).toEqual([
			{ id: "v1-message", text: "unchanged" },
		]);
	});

	test("returns only unreferenced deleted attachments to the storage cleanup hook", async () => {
		const { database, repository } = await setup();
		for (const id of ["survives", "orphaned"])
			await database.db.insertInto("v2_attachment").values({
				id,
				userId: USER_ID,
				storageKey: id,
				filename: `${id}.txt`,
				mimeType: "text/plain",
				kind: "text",
				byteSize: 1,
				sha256: id,
				width: null,
				height: null,
				pageCount: null,
				createdAt: new Date().toISOString(),
			}).execute();
		await database.db.insertInto("v2_message_attachment").values([
			{ messageId: "message-1", attachmentId: "survives", ordinal: 0 },
			{ messageId: "message-3", attachmentId: "orphaned", ordinal: 0 },
		]).execute();
		const cleaned: string[][] = [];
		const service = new ChatV2EditService(repository, (ids) => {
			cleaned.push([...ids]);
		});
		await service.editUserMessage({
			userId: USER_ID,
			conversationId: CONVERSATION_ID,
			targetTurnId: "user-2",
			message: { role: "user", content: "Replacement", timestamp: 10 },
			generation: generation("replacement-generation"),
		});
		expect(cleaned).toEqual([["orphaned"]]);
		expect(await database.db.selectFrom("v2_attachment").select("id").orderBy("id").execute()).toEqual([
			{ id: "orphaned" },
			{ id: "survives" },
		]);
	});

	test("invalidates intersecting compactions and rejects a stale repeated edit", async () => {
		const { database, repository } = await setup();
		await database.db.insertInto("v2_context_compaction").values({
			id: "compaction",
			conversationId: CONVERSATION_ID,
			firstMessageId: "message-1",
			lastMessageId: "message-3",
			replacementMessagesJson: "[]",
			sourceHash: "hash",
			promptVersion: "v1",
			provider: null,
			api: null,
			model: null,
			tokensBefore: null,
			tokensAfter: null,
			createdAt: new Date().toISOString(),
		}).execute();
		await database.db.insertInto("v2_context_compaction_job").values({
			id: "compaction-job",
			conversationId: CONVERSATION_ID,
			firstMessageId: "message-1",
			lastMessageId: "message-3",
			sourceHash: "hash",
			status: "running",
			compactionId: "compaction",
			errorMessage: null,
			createdAt: new Date().toISOString(),
			finishedAt: null,
		}).execute();
		const service = new ChatV2EditService(repository);
		const command = {
			userId: USER_ID,
			conversationId: CONVERSATION_ID,
			targetTurnId: "user-2",
			message: { role: "user" as const, content: "Replacement", timestamp: 10 },
			generation: generation("replacement-generation"),
		};
		await service.editUserMessage(command);
		expect(await database.db.selectFrom("v2_context_compaction").selectAll().execute()).toEqual([]);
		expect(await repository.getCompactionJob(USER_ID, "compaction-job")).toMatchObject({
			status: "stale",
			compactionId: null,
		});
		await expect(service.editUserMessage(command)).rejects.toBeInstanceOf(V2StaleTargetError);
	});
});
