import { afterEach, describe, expect, test } from "bun:test";
import type { Message } from "@earendil-works/pi-ai";
import { CompactionService } from "./compaction";
import { findSafeCompactionRange, materializeContext, sourceHash } from "./context";
import {
	compactionReplacementRange,
	plainTextExchange,
	toolCallResultContinuation,
} from "./fixtures";
import { createV2TestDatabase } from "./db/fixtures";
import { ChatV2Repository } from "./db/repository";
import { projectVisibleTurns } from "./projection";

const USER_ID = "compaction-user";
const CONVERSATION_ID = "compaction-conversation";

describe("chat-v2 context compaction", () => {
	const databases: Awaited<ReturnType<typeof createV2TestDatabase>>[] = [];

	afterEach(async () => {
		await Promise.all(
			databases.splice(0).map((database) => database.destroy()),
		);
	});

	async function setup(messages: readonly Message[] = plainTextExchange()) {
		const database = await createV2TestDatabase();
		databases.push(database);
		database.seedUser(USER_ID);
		const repository = new ChatV2Repository(database.db);
		await repository.createConversation(USER_ID, {
			id: CONVERSATION_ID,
			title: "Compaction",
		});
		let turnOrdinal = 0;
		let assistantTurnId: string | null = null;
		const inputs = [];
		for (const [index, message] of messages.entries()) {
			let turnId: string | null = assistantTurnId;
			if (message.role === "user" || !turnId) {
				turnId = `turn-${turnOrdinal}`;
				await repository.createTurn(USER_ID, CONVERSATION_ID, {
					id: turnId,
					ordinal: turnOrdinal,
					role: message.role === "user" ? "user" : "assistant",
					origin: "text",
					status: "complete",
				});
				turnOrdinal += 1;
			}
			assistantTurnId = message.role === "user" ? null : turnId;
			inputs.push({
				id: `message-${index}`,
				turnId: turnId!,
				message,
				origin: "text" as const,
				status: "complete" as const,
			});
		}
		await repository.appendCanonicalMessages(USER_ID, CONVERSATION_ID, inputs);
		return { database, repository, service: new CompactionService(repository) };
	}

	test("keeps canonical history while replacing a covered range in outbound context", async () => {
		const { repository, service } = await setup();
		const job = await service.enqueue(USER_ID, CONVERSATION_ID, {
			firstMessageId: "message-0",
			lastMessageId: "message-1",
		});
		const artifact = await service.run(
			USER_ID,
			job.id,
			async () => "The exchange was a greeting.",
		);
		expect(artifact).not.toBe("stale");
		const canonical = await repository.listCanonicalMessages(
			USER_ID,
			CONVERSATION_ID,
		);
		expect(canonical.map((message) => message.id)).toEqual([
			"message-0",
			"message-1",
		]);
		expect(
			projectVisibleTurns(canonical).map((turn) => turn.displayText),
		).toEqual(["Hello", "Hi."]);
		const result = materializeContext(
			CONVERSATION_ID,
			canonical,
			await repository.listCompactions(USER_ID, CONVERSATION_ID),
		);
		expect(result.context).toEqual(
			artifact === "stale" ? [] : artifact.replacementMessages,
		);
		expect(result.manifest).toMatchObject({
			messageIds: [],
			compactionIds: [artifact === "stale" ? "" : artifact.id],
		});
	});

	test("rejects a range that splits an assistant tool call from its result", async () => {
		const { service } = await setup(toolCallResultContinuation());
		await expect(
			service.enqueue(USER_ID, CONVERSATION_ID, {
				firstMessageId: "message-1",
				lastMessageId: "message-1",
			}),
		).rejects.toThrow("splits tool call weather-1 from its result");
	});
	test("findSafeCompactionRange adjusts candidate range away from split tool transactions", () => {
		const records = toolCallResultContinuation().map((message, index) => ({
			id: `message-${index}`,
			conversationId: CONVERSATION_ID,
			turnId: `turn-${index}`,
			ordinal: index,
			role: message.role === "user" ? ("user" as const) : ("assistant" as const),
			message,
			origin: "text" as const,
			status: "complete" as const,
			createdAt: new Date().toISOString(),
		}));
		// toolCallResultContinuation has:
		// 0: user
		// 1: assistant
		// 2: toolResult (weather-1)
		// 3: assistant (weather-1 tool call)

		// Candidate ending at 1 (assistant with tool call weather-1) splits weather-1 from its result (at 2)
		const adjusted = findSafeCompactionRange(records, 0, 1);
		expect(adjusted).toEqual({ firstIndex: 0, lastIndex: 0 });

		// Candidate ending at 2 includes both tool call (1) and result (2)
		const safe = findSafeCompactionRange(records, 0, 2);
		expect(safe).toEqual({ firstIndex: 0, lastIndex: 2 });
	});

	test("rejects overlapping completed compactions as ambiguous", async () => {
		const { repository, service } = await setup();
		await repository.appendCanonicalMessages(USER_ID, CONVERSATION_ID, [
			{
				id: "message-2",
				message: { role: "user", content: "Follow-up", timestamp: 3 },
				origin: "text",
				status: "complete",
			},
		]);
		const first = await service.enqueue(USER_ID, CONVERSATION_ID, {
			firstMessageId: "message-0",
			lastMessageId: "message-1",
		});
		const second = await service.enqueue(USER_ID, CONVERSATION_ID, {
			firstMessageId: "message-1",
			lastMessageId: "message-2",
		});
		await service.run(USER_ID, first.id, async () => "First summary");
		await service.run(USER_ID, second.id, async () => "Second summary");
		const messages = await repository.listCanonicalMessages(
			USER_ID,
			CONVERSATION_ID,
		);
		const compactions = await repository.listCompactions(
			USER_ID,
			CONVERSATION_ID,
		);
		expect(() =>
			materializeContext(CONVERSATION_ID, messages, compactions),
		).toThrow("overlap ambiguously");
	});

	test("keeps an earlier range valid when messages append while its job runs", async () => {
		const { repository, service } = await setup();
		const job = await service.enqueue(USER_ID, CONVERSATION_ID, {
			firstMessageId: "message-0",
			lastMessageId: "message-1",
		});
		await repository.appendCanonicalMessages(USER_ID, CONVERSATION_ID, [
			{
				id: "message-2",
				message: { role: "user", content: "One more question", timestamp: 3 },
				origin: "text",
				status: "complete",
			},
		]);
		expect(
			await service.run(USER_ID, job.id, async () => "Greeting summary"),
		).not.toBe("stale");
	});

	test("marks a running job stale when a covered source message is deleted", async () => {
		const { repository, service } = await setup();
		const job = await service.enqueue(USER_ID, CONVERSATION_ID, {
			firstMessageId: "message-0",
			lastMessageId: "message-1",
		});
		await repository.startCompactionJob(USER_ID, job.id);
		await repository.deleteMessageSuffix(USER_ID, CONVERSATION_ID, 1);
		const result = await repository.materializeCompactionJob(USER_ID, job.id, {
			replacementMessages: compactionReplacementRange(),
			promptVersion: "v1",
		});
		expect(result).toBe("stale");
		expect(await repository.getCompactionJob(USER_ID, job.id)).toMatchObject({
			status: "stale",
			compactionId: null,
		});
	});

	test("falls back to full canonical history when all artifacts are removed", async () => {
		const { database, repository, service } = await setup();
		const job = await service.enqueue(USER_ID, CONVERSATION_ID, {
			firstMessageId: "message-0",
			lastMessageId: "message-1",
		});
		await service.run(USER_ID, job.id, async () => "Greeting summary");
		await database.db.deleteFrom("v2_context_compaction").execute();
		const messages = await repository.listCanonicalMessages(
			USER_ID,
			CONVERSATION_ID,
		);
		const result = materializeContext(
			CONVERSATION_ID,
			messages,
			await repository.listCompactions(USER_ID, CONVERSATION_ID),
		);
		expect(result.context).toEqual(messages.map((message) => message.message));
		expect(result.manifest.compactionIds).toEqual([]);
	});

	test("records exactly the live messages and compactions used by a generation", async () => {
		const { repository, service } = await setup();
		const job = await service.enqueue(USER_ID, CONVERSATION_ID, {
			firstMessageId: "message-0",
			lastMessageId: "message-0",
		});
		const artifact = await service.run(
			USER_ID,
			job.id,
			async () => "The user greeted the assistant.",
		);
		expect(artifact).not.toBe("stale");
		const result = materializeContext(
			CONVERSATION_ID,
			await repository.listCanonicalMessages(USER_ID, CONVERSATION_ID),
			await repository.listCompactions(USER_ID, CONVERSATION_ID),
		);
		await repository.createGeneration(USER_ID, CONVERSATION_ID, {
			id: "generation-1",
			status: "pending",
			provider: "fixture",
			api: "openai-completions",
			model: "fixture",
			requestJson: "{}",
		});
		await repository.recordGenerationContextManifest(
			USER_ID,
			"generation-1",
			result.manifest,
		);
		const generation = await repository.getGeneration(USER_ID, "generation-1");
		expect(JSON.parse(generation.contextManifestJson!)).toEqual(
			result.manifest,
		);
		expect(result.manifest).toMatchObject({
			messageIds: ["message-1"],
			compactionIds: [artifact === "stale" ? "" : artifact.id],
		});
	});

	test("hashes ordered message identities and payloads deterministically", async () => {
		const { repository } = await setup();
		const messages = await repository.listCanonicalMessages(
			USER_ID,
			CONVERSATION_ID,
		);
		expect(sourceHash(messages)).toBe(
			sourceHash(
				messages.map((message) => ({
					...message,
					message: JSON.parse(JSON.stringify(message.message)),
				})),
			),
		);
	});
});
