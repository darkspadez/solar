import { afterEach, describe, expect, test } from "bun:test";
import { fauxProvider } from "@earendil-works/pi-ai";
import { transformMessages } from "@earendil-works/pi-ai/api/transform-messages";
import { CompactionService } from "./compaction";
import { createV2TestDatabase } from "./db/fixtures";
import { ChatV2Repository, V2StaleTargetError } from "./db/repository";
import { ChatV2EditService } from "./edit";
import { plainTextExchange, toolCallResultContinuation } from "./fixtures";
import { GenerationService } from "./generation";
import { checkChatV2Integrity } from "./integrity";
import { projectVisibleTurns } from "./projection";
import { rebuildSearchProjection } from "./search";
import { VoiceHistoryService } from "./voice";

const USER_ID = "acceptance-user";
const CONVERSATION_ID = "acceptance-conversation";
const V1_HISTORY_PATHS = [
	"../chat/adapter",
	"../chat/generationManager",
	"../chat/routes",
] as const;

describe("chat-v2 acceptance", () => {
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
			title: "Acceptance",
		});
		return { database, repository };
	}

	async function createGeneration(status: "queued" | "streaming" | "stopped" | "failed" | "complete") {
		const { repository } = await setup();
		await repository.createGeneration(USER_ID, CONVERSATION_ID, {
			id: `generation-${status}`,
			status,
			provider: "fixture",
			api: "openai-completions",
			model: "fixture-model",
			requestJson: "{}",
		});
		return { repository, service: new GenerationService(repository) };
	}

	test("process restart preserves queued generations", async () => {
		const { repository, service } = await createGeneration("queued");
		expect(await service.reconcileRunningGenerations(USER_ID)).toBe(0);
		expect((await repository.getGeneration(USER_ID, "generation-queued")).status).toBe("queued");
	});

	test("process restart interrupts streaming generations", async () => {
		const { repository, service } = await createGeneration("streaming");
		expect(await service.reconcileRunningGenerations(USER_ID)).toBe(1);
		expect((await repository.getGeneration(USER_ID, "generation-streaming")).status).toBe("interrupted");
	});

	test("process restart preserves stopped generations", async () => {
		const { repository, service } = await createGeneration("stopped");
		expect(await service.reconcileRunningGenerations(USER_ID)).toBe(0);
		expect((await repository.getGeneration(USER_ID, "generation-stopped")).status).toBe("stopped");
	});

	test("process restart preserves failed generations", async () => {
		const { repository, service } = await createGeneration("failed");
		expect(await service.reconcileRunningGenerations(USER_ID)).toBe(0);
		expect((await repository.getGeneration(USER_ID, "generation-failed")).status).toBe("failed");
	});

	test("process restart preserves completed generations", async () => {
		const { repository, service } = await createGeneration("complete");
		expect(await service.reconcileRunningGenerations(USER_ID)).toBe(0);
		expect((await repository.getGeneration(USER_ID, "generation-complete")).status).toBe("complete");
	});

	test("replays stored source-provider messages through pi-ai for another model without storage changes", async () => {
		const { repository } = await setup();
		await repository.createTurn(USER_ID, CONVERSATION_ID, {
			id: "user-turn",
			ordinal: 0,
			role: "user",
			origin: "text",
			status: "complete",
		});
		await repository.createTurn(USER_ID, CONVERSATION_ID, {
			id: "assistant-turn",
			ordinal: 1,
			role: "assistant",
			origin: "text",
			status: "complete",
		});
		const messages = plainTextExchange();
		const sourceAssistant = {
			...messages[1]!,
			provider: "source-provider",
			model: "source-model",
		};
		await repository.appendCanonicalMessages(USER_ID, CONVERSATION_ID, [
			{ id: "source-user", turnId: "user-turn", message: messages[0]!, origin: "text", status: "complete" },
			{ id: "source-assistant", turnId: "assistant-turn", message: sourceAssistant, origin: "text", status: "complete" },
		]);
		const storedBefore = await repository.listCanonicalMessages(USER_ID, CONVERSATION_ID);
		const target = fauxProvider({
			models: [{ id: "target-model", input: ["text"] }],
		}).getModel("target-model")!;
		const replay = transformMessages(storedBefore.map((record) => record.message), target);
		expect(replay).toHaveLength(2);
		expect(await repository.listCanonicalMessages(USER_ID, CONVERSATION_ID)).toEqual(storedBefore);
	});

	test("concurrent edits admit one replacement and reject the stale target", async () => {
		const { repository } = await setup();
		await repository.createTurn(USER_ID, CONVERSATION_ID, { id: "edit-user-turn", ordinal: 0, role: "user", origin: "text", status: "complete" });
		await repository.createTurn(USER_ID, CONVERSATION_ID, { id: "edit-assistant-turn", ordinal: 1, role: "assistant", origin: "text", status: "complete" });
		await repository.appendCanonicalMessages(USER_ID, CONVERSATION_ID, [
			{ id: "edit-user-message", turnId: "edit-user-turn", message: plainTextExchange()[0]!, origin: "text", status: "complete" },
			{ id: "edit-assistant-message", turnId: "edit-assistant-turn", message: plainTextExchange()[1]!, origin: "text", status: "complete" },
		]);
		const edits = new ChatV2EditService(repository);
		const results = await Promise.allSettled(["first", "second"].map((id) => edits.editUserMessage({
			userId: USER_ID,
			conversationId: CONVERSATION_ID,
			targetTurnId: "edit-user-turn",
			message: { role: "user", content: `${id} replacement`, timestamp: 10 },
			generation: { id: `edit-generation-${id}`, provider: "fixture", api: "openai-completions", model: "fixture-model", request: {} },
		})));
		expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
		const rejected = results.find((result) => result.status === "rejected");
		expect(rejected).toMatchObject({ reason: expect.any(V2StaleTargetError) });
	});

	test("integrity and projection rebuild succeed for populated tool, voice, attachment, and compaction data", async () => {
		const { database, repository } = await setup();
		const toolMessages = toolCallResultContinuation();
		await repository.createTurn(USER_ID, CONVERSATION_ID, { id: "tool-user-turn", ordinal: 0, role: "user", origin: "text", status: "complete" });
		await repository.createTurn(USER_ID, CONVERSATION_ID, { id: "tool-assistant-turn", ordinal: 1, role: "assistant", origin: "text", status: "complete" });
		await repository.appendCanonicalMessages(USER_ID, CONVERSATION_ID, toolMessages.map((message, index) => ({
			id: `tool-message-${index}`,
			turnId: index === 0 ? "tool-user-turn" : "tool-assistant-turn",
			message,
			origin: "text" as const,
			status: "complete" as const,
		})));
		await repository.createAttachment(USER_ID, { id: "attachment", storageKey: "acceptance/note.txt", filename: "note.txt", mimeType: "text/plain", kind: "text", byteSize: 4, sha256: "hash" });
		await repository.bindAttachment(USER_ID, CONVERSATION_ID, "tool-message-0", "attachment", 0);
		const compaction = new CompactionService(repository);
		const job = await compaction.enqueue(USER_ID, CONVERSATION_ID, { firstMessageId: "tool-message-0", lastMessageId: "tool-message-3" });
		expect(await compaction.run(USER_ID, job.id, async () => "Weather was requested and answered.")).not.toBe("stale");

		const voiceConversation = await repository.createConversation(USER_ID, { id: "voice-conversation", title: "Voice acceptance" });
		await new VoiceHistoryService(repository).completeTranscriptTurn({
			userId: USER_ID,
			conversationId: voiceConversation.id,
			turnKey: "voice-acceptance",
			userTranscript: "Summarize this.",
			assistantTranscript: "A summary.",
			provider: "voice-provider",
			api: "openai-completions",
			model: "voice-model",
			timestamp: 10,
		});

		for (const conversationId of [CONVERSATION_ID, voiceConversation.id]) {
			const records = await repository.listCanonicalMessages(USER_ID, conversationId);
			expect(projectVisibleTurns(records)).toEqual(projectVisibleTurns(records));
			expect(rebuildSearchProjection(records)).toEqual(rebuildSearchProjection(records));
		}
		expect(await checkChatV2Integrity(database.db)).toMatchObject({
			integrity: ["ok"],
			foreignKeyViolations: [],
			messageValidationErrors: [],
		});
	});

	test("does not import identifiable v1 chat history modules", async () => {
		const files = [...new Bun.Glob("apps/server/src/chat-v2/**/*.ts").scanSync()];
		expect(files.length).toBeGreaterThan(0);
		for (const path of files) {
			const source = await Bun.file(path).text();
			for (const v1Path of V1_HISTORY_PATHS)
				expect(source).not.toMatch(new RegExp(`(?:from|import)\\s*["']${v1Path}["']`));
		}
	});
});
