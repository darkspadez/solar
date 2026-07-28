import { afterEach, describe, expect, test } from "bun:test";
import type { AssistantMessage, Message, UserMessage } from "@earendil-works/pi-ai";
import { toolCallResultContinuation } from "./fixtures";
import { loadCanonicalHistory } from "./history";
import { projectVisibleTurns } from "./projection";
import { createV2TestDatabase } from "./db/fixtures";
import { ChatV2Repository } from "./db/repository";

const USER_ID = "history-user";
const PROVIDER = "solar-fixture";
const API = "openai-completions";
const MODEL = "fixture-model";

describe("chat-v2 canonical history", () => {
	const databases: Awaited<ReturnType<typeof createV2TestDatabase>>[] = [];

	afterEach(async () => {
		await Promise.all(databases.splice(0).map((database) => database.destroy()));
	});

	async function setup() {
		const database = await createV2TestDatabase();
		databases.push(database);
		database.seedUser(USER_ID);
		const repository = new ChatV2Repository(database.db);
		const conversation = await repository.createConversation(USER_ID, {
			id: "conversation-1",
			title: "Canonical history",
		});
		return { repository, conversationId: conversation.id };
	}

	async function appendUserTurn(
		repository: ChatV2Repository,
		conversationId: string,
		turnId: string,
		ordinal: number,
		message: UserMessage,
	) {
		await repository.createTurn(USER_ID, conversationId, {
			id: turnId,
			ordinal,
			role: "user",
			origin: "text",
			status: "complete",
		});
		await repository.appendCanonicalMessages(USER_ID, conversationId, [
			{ id: `${turnId}-message`, turnId, message, origin: "text", status: "complete" },
		]);
	}

	async function finalizeAssistantTurn(
		repository: ChatV2Repository,
		conversationId: string,
		turnId: string,
		ordinal: number,
		generationId: string,
		messages: readonly Message[],
	) {
		await repository.createTurn(USER_ID, conversationId, {
			id: turnId,
			ordinal,
			role: "assistant",
			origin: "text",
			status: "pending",
		});
		await repository.createGeneration(USER_ID, conversationId, {
			id: generationId,
			turnId,
			status: "streaming",
			provider: PROVIDER,
			api: API,
			model: MODEL,
			requestJson: "{}",
		});
		await repository.finalizeGeneration(USER_ID, generationId, {
			status: "complete",
			messages: messages.map((message, index) => ({
				id: `${generationId}-message-${index}`,
				turnId,
				message,
				origin: "text",
				status: "complete",
			})),
		});
	}

	test("persists and reloads a multi-turn pi-ai sequence without Solar transformation", async () => {
		const { repository, conversationId } = await setup();
		const fixtureAssistant = toolCallResultContinuation()[3] as AssistantMessage;
		const firstUser: UserMessage = { role: "user", content: "Hello", timestamp: 1 };
		const firstAssistant: AssistantMessage = {
			...fixtureAssistant,
			content: [
				{ type: "thinking", thinking: "Reply briefly." },
				{ type: "text", text: "Hi." },
			],
			timestamp: 2,
		};
		const secondUser: UserMessage = {
			role: "user",
			content: "How are you?",
			timestamp: 3,
		};
		const secondAssistant: AssistantMessage = {
			...fixtureAssistant,
			content: [{ type: "text", text: "Well." }],
			timestamp: 4,
		};
		await appendUserTurn(repository, conversationId, "turn-user-1", 0, firstUser);
		await finalizeAssistantTurn(repository, conversationId, "turn-assistant-1", 1, "generation-1", [firstAssistant]);
		await appendUserTurn(repository, conversationId, "turn-user-2", 2, secondUser);
		await finalizeAssistantTurn(repository, conversationId, "turn-assistant-2", 3, "generation-2", [secondAssistant]);

		const persisted = [firstUser, firstAssistant, secondUser, secondAssistant];
		expect(await repository.getGeneration(USER_ID, "generation-1")).toMatchObject({
			provider: PROVIDER,
			api: API,
			model: MODEL,
			status: "complete",
		});
		const reloaded = await loadCanonicalHistory(repository, USER_ID, conversationId);
		expect(reloaded).toEqual(persisted);
		const providerRequest = reloaded;
		expect(providerRequest).toEqual(persisted);
		const turns = projectVisibleTurns(await repository.listCanonicalMessages(USER_ID, conversationId));
		expect(turns.map((turn) => turn.displayText)).toEqual(["Hello", "Hi.", "How are you?", "Well."]);
		expect(turns[1]?.reasoning).toEqual(["Reply briefly."]);
	});

	test("projects a tool loop as one assistant turn while retaining each canonical message", async () => {
		const { repository, conversationId } = await setup();
		const [user, ...assistantMessages] = toolCallResultContinuation();
		await appendUserTurn(repository, conversationId, "turn-user", 0, user as UserMessage);
		await finalizeAssistantTurn(repository, conversationId, "turn-assistant", 1, "generation-tool", assistantMessages);

		const records = await repository.listCanonicalMessages(USER_ID, conversationId);
		expect(records.map((record) => record.message)).toEqual(toolCallResultContinuation());
		expect(records.map((record) => record.ordinal)).toEqual([0, 1, 2, 3]);
		const turns = projectVisibleTurns(records);
		expect(turns).toHaveLength(2);
		expect(turns[1]?.messages.map((record) => record.role)).toEqual([
			"assistant",
			"toolResult",
			"assistant",
		]);
		expect(turns[1]?.displayText).toBe("20 C and clear\nIt is 20 C and clear in Austin.");
	});
});
