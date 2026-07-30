import { afterEach, describe, expect, mock, test } from "bun:test";
import type { AssistantMessage, Message } from "@earendil-works/pi-ai";
import { createV2TestDatabase } from "../chat-v2/db/fixtures";
import { zeroUsage } from "../chat-v2/validation";

const USER_ID = "context-user";
const database = await createV2TestDatabase();
database.seedUser(USER_ID);

mock.module("../db", () => ({ db: database.db, sqlite: database.sqlite }));
mock.module("../auth", () => ({
	createSolarApiKey: async () => ({ id: "key", key: "sk_solar_test" }),
	createSolarUser: async () => {},
	setSolarUserPassword: async () => true,
}));
mock.module("../chat/attachments", () => ({
	deleteAttachmentFilesForMessages: async () => {},
	deleteAttachmentFilesForUser: async () => {},
	deleteAttachmentFilesByStorageKey: async () => {},
	expandAttachmentRows: async () => ({ parts: [], documents: [] }),
}));
mock.module("../chat/generationManager", () => ({
	generationManager: { isActive: () => false },
}));
mock.module("../logger", () => ({
	logger: {
		withMetadata: () => ({ trace: () => {}, debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }),
		withError: () => ({ withMetadata: () => ({ warn: () => {}, error: () => {} }) }),
	},
	getLogLevel: () => "info",
	setLogLevel: () => {},
}));
mock.module("../chat/catalog", () => ({
	MOCK: true,
	PROVIDER_APIS: ["openai-responses"],
	parseAllowlist: () => [],
	listAvailableModels: async () => [],
	resolveSelection: async () => ({
		provider: "mock",
		endpointId: "mock",
		modelId: "mock",
		api: "mock",
	}),
	resolveModel: async () => {
		throw new Error("resolveModel should not be called in this test");
	},
	streamModel: () => {
		throw new Error("streamModel should not be called in this test");
	},
	resolveTaskModelOrFallback: async (selection: unknown) => selection,
	getModelCapabilities: async () => ({
		reasoningLevels: [],
		supportsVerbosity: false,
		defaultReasoningEffort: null,
		defaultVerbosity: null,
	}),
	documentInputMimeTypes: async () => [],
	documentInputCapabilities: async () => ({ nativeMimeTypes: [], extractedTextMimeTypes: [] }),
	getUserDefault: async () => null,
	setUserDefault: async () => {},
	getUserDefaultPreset: async () => null,
	setUserDefaultPreset: async () => {},
	getUserDefaultDisplayMode: async () => "compact",
	setUserDefaultDisplayMode: async () => {},
	getAdminDefault: async () => null,
	setAdminDefault: async () => {},
	getTaskModel: async () => null,
	setTaskModel: async () => {},
	getTitlePrompt: async () => "",
	setTitlePrompt: async () => {},
	importProviderModels: async () => {},
	loadProviderConfigs: async () => [],
}));

const { appRouter } = await import("./router");
const { chatV2Repository } = await import("../chat/v2Live");
const { DEFAULT_CONTEXT_GLOBAL_SETTINGS, parseContextGlobalSettings } =
	await import("../context/settings");

function assistant(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		timestamp: Date.now(),
		provider: "mock",
		api: "openai-completions",
		model: "mock",
		usage: zeroUsage(),
		stopReason: "stop",
	};
}

async function seedCompactableConversation(conversationId: string) {
	await chatV2Repository.createConversation(USER_ID, { id: conversationId, title: "Chat" });
	const messages: Message[] = [
		{ role: "user", content: "first", timestamp: 1 },
		assistant("first reply"),
		{ role: "user", content: "second", timestamp: 2 },
		assistant("second reply"),
		{ role: "user", content: "third", timestamp: 3 },
		assistant("third reply"),
	];
	for (const [ordinal, message] of messages.entries()) {
		const turnId = `turn-${ordinal}`;
		await chatV2Repository.createTurn(USER_ID, conversationId, {
			id: turnId,
			ordinal,
			role: message.role === "user" ? "user" : "assistant",
			origin: "text",
			status: "complete",
		});
		await chatV2Repository.appendCanonicalMessages(USER_ID, conversationId, [{
			id: `message-${ordinal}`,
			turnId,
			message,
			origin: "text",
			status: "complete",
		}]);
	}
}

describe("context management metadata", () => {
	afterEach(async () => {
		await database.reset();
		database.seedUser(USER_ID);
	});

	test("uses built-in settings for absent, malformed, and unsupported metadata", () => {
		expect(parseContextGlobalSettings(null)).toEqual(
			DEFAULT_CONTEXT_GLOBAL_SETTINGS,
		);
		expect(parseContextGlobalSettings("not json")).toEqual(
			DEFAULT_CONTEXT_GLOBAL_SETTINGS,
		);
		expect(parseContextGlobalSettings(JSON.stringify({ version: 2 }))).toEqual(
			DEFAULT_CONTEXT_GLOBAL_SETTINGS,
		);
	});

	test("accepts a complete versioned policy with a prompt override", () => {
		const settings = {
			...DEFAULT_CONTEXT_GLOBAL_SETTINGS,
			enabled: false,
			summaryPromptOverride: "Keep decisions and open questions.",
		};

		expect(parseContextGlobalSettings(JSON.stringify(settings))).toEqual(
			settings,
		);
	});

	test("rejects an empty prompt override", () => {
		const settings = {
			...DEFAULT_CONTEXT_GLOBAL_SETTINGS,
			summaryPromptOverride: "",
		};

		expect(parseContextGlobalSettings(JSON.stringify(settings))).toEqual(
			DEFAULT_CONTEXT_GLOBAL_SETTINGS,
		);
	});

	test("returns idle context status for a conversation with no compactions", async () => {
		const conversation = await chatV2Repository.createConversation(USER_ID, { title: "Chat" });
		const caller = appRouter.createCaller({ user: { id: USER_ID } } as never);

		await expect(
			caller.conversation.contextState({ conversationId: conversation.id }),
		).resolves.toEqual({
			state: "idle",
			estimatedTokens: null,
			summarized: false,
			jobError: null,
			summaryEvent: null,
		});
	});

	test("reports a summarized context status once a compaction is manually created", async () => {
		const conversationId = "compactable-conversation";
		await seedCompactableConversation(conversationId);
		const caller = appRouter.createCaller({ user: { id: USER_ID } } as never);

		await caller.conversation.compact({ conversationId });

		const status = await caller.conversation.contextState({ conversationId });
		expect(status.state).toBe("idle");
		expect(status.summarized).toBe(true);
		expect(status.summaryEvent).not.toBeNull();
	});
	test("successfully manually compacts when messages.length - 3 falls on a tool call", async () => {
		const conversationId = "tool-compact-conversation";
		await chatV2Repository.createConversation(USER_ID, { id: conversationId, title: "Tool Chat" });
		const messages: Message[] = [
			{ role: "user", content: "first query", timestamp: 1 },
			assistant("first reply"),
			{ role: "user", content: "second query", timestamp: 2 },
			{
				role: "assistant",
				content: [{ type: "toolCall", id: "tool-1", name: "search", arguments: {} }],
				timestamp: 3,
				provider: "mock",
				api: "openai-completions",
				model: "mock",
				usage: zeroUsage(),
				stopReason: "toolUse",
			},
			{
				role: "toolResult",
				toolCallId: "tool-1",
				toolName: "search",
				content: [{ type: "text", text: "search output" }],
				isError: false,
				timestamp: 4,
			},
			assistant("third reply"),
		];
		for (const [ordinal, message] of messages.entries()) {
			const turnId = `turn-${ordinal}`;
			await chatV2Repository.createTurn(USER_ID, conversationId, {
				id: turnId,
				ordinal,
				role: message.role === "user" ? "user" : "assistant",
				origin: "text",
				status: "complete",
			});
			await chatV2Repository.appendCanonicalMessages(USER_ID, conversationId, [{
				id: `message-${ordinal}`,
				turnId,
				message,
				origin: "text",
				status: "complete",
			}]);
		}

		const caller = appRouter.createCaller({ user: { id: USER_ID } } as never);
		await expect(caller.conversation.compact({ conversationId })).resolves.toEqual({ success: true });
	});

	test("rejects context status for a conversation the user does not own", async () => {
		const conversation = await chatV2Repository.createConversation(USER_ID, { title: "Chat" });
		const caller = appRouter.createCaller({ user: { id: "someone-else" } } as never);

		await expect(
			caller.conversation.contextState({ conversationId: conversation.id }),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
	});

	test("rejects compact for a conversation the user does not own", async () => {
		const conversation = await chatV2Repository.createConversation(USER_ID, { title: "Chat" });
		const caller = appRouter.createCaller({ user: { id: "someone-else" } } as never);

		await expect(
			caller.conversation.compact({ conversationId: conversation.id }),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
	});
});
