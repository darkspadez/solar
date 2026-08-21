import { afterEach, describe, expect, mock, test } from "bun:test";
import { createV2TestDatabase } from "../chat-v2/db/fixtures";

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
	normalizeBaseUrlForApi: () => "",
}));

const { appRouter } = await import("./router");
const { chatV2Repository } = await import("../chat-v2/db/repository");
const { DEFAULT_CONTEXT_GLOBAL_SETTINGS, parseContextGlobalSettings } =
	await import("../context/settings");

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

	test("returns idle context status for a conversation with no pi session", async () => {
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
