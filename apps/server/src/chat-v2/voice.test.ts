import { afterEach, describe, expect, test } from "bun:test";
import { fauxProvider } from "@earendil-works/pi-ai";
import { transformMessages } from "@earendil-works/pi-ai/api/transform-messages";
import { CompactionService } from "./compaction";
import { materializeContext } from "./context";
import { createV2TestDatabase } from "./db/fixtures";
import { ChatV2Repository } from "./db/repository";
import { ChatV2EditService } from "./edit";
import { loadCanonicalHistory } from "./history";
import { rebuildSearchProjection, searchProjection } from "./search";
import { zeroUsage } from "./validation";
import {
	VoiceHistoryService,
	voiceAssistantMessage,
	voiceUserMessage,
} from "./voice";

const USER_ID = "voice-user";
const CONVERSATION_ID = "voice-conversation";
const PROVIDER = "voice-fixture";
const API = "openai-completions";
const MODEL = "voice-model";

describe("chat-v2 voice history", () => {
	const databases: Awaited<ReturnType<typeof createV2TestDatabase>>[] = [];

	afterEach(async () => {
		await Promise.all(
			databases.splice(0).map((database) => database.destroy()),
		);
	});

	async function setup() {
		const database = await createV2TestDatabase();
		databases.push(database);
		database.seedUser(USER_ID);
		const repository = new ChatV2Repository(database.db);
		await repository.createConversation(USER_ID, {
			id: CONVERSATION_ID,
			title: "Voice",
		});
		return { database, repository, voice: new VoiceHistoryService(repository) };
	}

	async function completeVoiceTurn(
		voice: VoiceHistoryService,
		turnKey = "voice-turn",
	) {
		return voice.completeTranscriptTurn({
			userId: USER_ID,
			conversationId: CONVERSATION_ID,
			turnKey,
			userTranscript: "What happened in the meeting?",
			assistantTranscript: "The team confirmed the launch date.",
			provider: PROVIDER,
			api: API,
			model: MODEL,
			timestamp: 100,
			metadata: {
				interrupted: true,
				truncated: true,
				interruptionReason: "user_barge_in",
			},
		});
	}

	async function appendTextTurn(repository: ChatV2Repository) {
		await repository.createTurn(USER_ID, CONVERSATION_ID, {
			id: "text-user-turn",
			ordinal: 2,
			role: "user",
			origin: "text",
			status: "complete",
		});
		await repository.createTurn(USER_ID, CONVERSATION_ID, {
			id: "text-assistant-turn",
			ordinal: 3,
			role: "assistant",
			origin: "text",
			status: "pending",
		});
		await repository.appendCanonicalMessages(USER_ID, CONVERSATION_ID, [
			{
				id: "text-user-message",
				turnId: "text-user-turn",
				origin: "text",
				status: "complete",
				message: {
					role: "user",
					content: "What should I do next?",
					timestamp: 102,
				},
			},
		]);
		await repository.createGeneration(USER_ID, CONVERSATION_ID, {
			id: "text-generation",
			turnId: "text-assistant-turn",
			status: "running",
			provider: PROVIDER,
			api: API,
			model: MODEL,
			requestJson: "{}",
		});
		await repository.completeGeneration(USER_ID, "text-generation", {
			messages: [
				{
					id: "text-assistant-message",
					turnId: "text-assistant-turn",
					origin: "text",
					status: "complete",
					message: voiceAssistantMessage("Send the follow-up today.", {
						provider: PROVIDER,
						api: API,
						model: MODEL,
						timestamp: 103,
					}),
				},
			],
			usage: zeroUsage(),
			stopReason: "stop",
		});
	}

	test("constructs complete transcript messages with ordinary pi-ai roles", () => {
		expect(voiceUserMessage("Hello", 1)).toEqual({
			role: "user",
			content: [{ type: "text", text: "Hello" }],
			timestamp: 1,
		});
		expect(
			voiceAssistantMessage("Hi", {
				provider: PROVIDER,
				api: API,
				model: MODEL,
				timestamp: 2,
			}),
		).toMatchObject({
			role: "assistant",
			content: [{ type: "text", text: "Hi" }],
			usage: zeroUsage(),
			stopReason: "stop",
			timestamp: 2,
		});
	});

	test("loads mixed voice and text history through normal context and cross-provider replay", async () => {
		const { repository, voice } = await setup();
		await completeVoiceTurn(voice);
		await appendTextTurn(repository);
		const records = await repository.listCanonicalMessages(
			USER_ID,
			CONVERSATION_ID,
		);
		expect(
			records.map((record) => [record.origin, record.message.role]),
		).toEqual([
			["voice", "user"],
			["voice", "assistant"],
			["text", "user"],
			["text", "assistant"],
		]);
		const history = await loadCanonicalHistory(
			repository,
			USER_ID,
			CONVERSATION_ID,
		);
		expect(materializeContext(CONVERSATION_ID, records, []).context).toEqual(
			history,
		);
		const provider = fauxProvider({
			models: [{ id: "other-model", input: ["text"] }],
		});
		expect(
			transformMessages(history, provider.getModel("other-model")!),
		).toEqual(history);
		expect(rebuildSearchProjection(records).map((entry) => entry.text)).toEqual(
			[
				"What happened in the meeting?",
				"The team confirmed the launch date.",
				"What should I do next?",
				"Send the follow-up today.",
			],
		);
		expect(
			searchProjection(rebuildSearchProjection(records), "launch").map(
				(entry) => entry.messageId,
			),
		).toEqual([records[1]!.id]);
	});

	test("deduplicates realtime callbacks by turn key and binds optional audio", async () => {
		const { repository, voice } = await setup();
		await repository.createAttachment(USER_ID, {
			id: "audio",
			storageKey: "audio/turn.webm",
			filename: "turn.webm",
			mimeType: "audio/webm",
			kind: "audio",
			byteSize: 8,
			sha256: "audio",
		});
		const first = await voice.completeTranscriptTurn({
			...(await voiceInput()),
			audioAttachmentId: "audio",
		});
		const duplicate = await voice.completeTranscriptTurn({
			...(await voiceInput()),
			audioAttachmentId: "audio",
		});
		expect(first.created).toBe(true);
		expect(duplicate.created).toBe(false);
		expect(
			await repository.listCanonicalMessages(USER_ID, CONVERSATION_ID),
		).toHaveLength(2);
		expect(
			await repository.listMessageAttachments(USER_ID, CONVERSATION_ID),
		).toMatchObject([
			{ messageId: first.userMessageId, attachment: { id: "audio" } },
		]);
		expect(first.voiceTurn.metadata).toEqual({
			interrupted: true,
			truncated: true,
			interruptionReason: "user_barge_in",
		});
		expect(
			await repository.getGeneration(USER_ID, first.voiceTurn.generationId),
		).toMatchObject({ status: "complete", stopReason: "stop" });
	});

	test("compacts voice transcripts without changing canonical history", async () => {
		const { repository, voice } = await setup();
		await completeVoiceTurn(voice);
		const service = new CompactionService(repository);
		const job = await service.enqueue(USER_ID, CONVERSATION_ID, {
			firstMessageId: (
				await repository.listCanonicalMessages(USER_ID, CONVERSATION_ID)
			)[0]!.id,
			lastMessageId: (
				await repository.listCanonicalMessages(USER_ID, CONVERSATION_ID)
			)[1]!.id,
		});
		await service.run(
			USER_ID,
			job.id,
			async () => "Meeting transcript summary.",
		);
		expect(
			(await repository.listCanonicalMessages(USER_ID, CONVERSATION_ID)).map(
				(record) => record.origin,
			),
		).toEqual(["voice", "voice"]);
		expect(
			materializeContext(
				CONVERSATION_ID,
				await repository.listCanonicalMessages(USER_ID, CONVERSATION_ID),
				await repository.listCompactions(USER_ID, CONVERSATION_ID),
			).context,
		).toHaveLength(1);
	});

	test("voice turns follow ordinary destructive edit and regenerate semantics", async () => {
		const { repository, voice } = await setup();
		const persisted = await completeVoiceTurn(voice);
		await appendTextTurn(repository);
		const edits = new ChatV2EditService(repository);
		await edits.regenerateAssistantTurn({
			userId: USER_ID,
			conversationId: CONVERSATION_ID,
			targetTurnId: persisted.voiceTurn.assistantTurnId,
			generation: {
				id: "regenerated",
				provider: PROVIDER,
				api: API,
				model: MODEL,
				request: {},
			},
		});
		expect(
			(await repository.listCanonicalMessages(USER_ID, CONVERSATION_ID)).map(
				(record) => record.origin,
			),
		).toEqual(["voice"]);
		await edits.editUserMessage({
			userId: USER_ID,
			conversationId: CONVERSATION_ID,
			targetTurnId: persisted.voiceTurn.userTurnId,
			message: { role: "user", content: "Typed replacement", timestamp: 200 },
			generation: {
				id: "edited",
				provider: PROVIDER,
				api: API,
				model: MODEL,
				request: {},
			},
		});
		expect(
			await loadCanonicalHistory(repository, USER_ID, CONVERSATION_ID),
		).toEqual([{ role: "user", content: "Typed replacement", timestamp: 200 }]);
	});
});

async function voiceInput() {
	return {
		userId: USER_ID,
		conversationId: CONVERSATION_ID,
		turnKey: "voice-turn",
		userTranscript: "What happened in the meeting?",
		assistantTranscript: "The team confirmed the launch date.",
		provider: PROVIDER,
		api: API,
		model: MODEL,
		timestamp: 100,
		metadata: {
			interrupted: true,
			truncated: true,
			interruptionReason: "user_barge_in",
		},
	} as const;
}
