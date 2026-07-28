import { afterEach, describe, expect, test } from "bun:test";
import { mock } from "bun:test";
import { createV2TestDatabase } from "../chat-v2/db/fixtures";

const USER_ID = "settings-user";
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
		withMetadata: () => ({ trace: () => {}, info: () => {}, warn: () => {}, error: () => {} }),
		withError: () => ({ withMetadata: () => ({ warn: () => {}, error: () => {} }) }),
	},
	getLogLevel: () => "info",
	setLogLevel: () => {},
}));

const MODEL_DESCRIPTOR = {
	provider: "openai",
	endpointId: "openai-default",
	modelId: "gpt-5.6",
	api: "openai-responses",
	name: "GPT 5.6",
	reasoning: true,
	vision: false,
	documents: false,
};

mock.module("../chat/catalog", () => ({
	MOCK: true,
	PROVIDER_APIS: ["openai-responses"],
	parseAllowlist: () => [],
	listAvailableModels: async () => [MODEL_DESCRIPTOR],
	resolveSelection: async (
		selection: { provider?: string; endpointId?: string; modelId?: string; api?: string },
	) => ({
		provider: selection.provider ?? MODEL_DESCRIPTOR.provider,
		endpointId: selection.endpointId ?? MODEL_DESCRIPTOR.endpointId,
		modelId: selection.modelId ?? MODEL_DESCRIPTOR.modelId,
		api: selection.api ?? MODEL_DESCRIPTOR.api,
	}),
	resolveModel: async () => {
		throw new Error("resolveModel should not be called in this test");
	},
	streamModel: () => {
		throw new Error("streamModel should not be called in this test");
	},
	resolveTaskModelOrFallback: async (selection: unknown) => selection,
	getModelCapabilities: async () => ({
		reasoningLevels: ["low", "medium", "high"],
		supportsVerbosity: true,
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

function caller() {
	return appRouter.createCaller({ user: { id: USER_ID, role: "user" } } as never);
}

describe("chat-v2 conversation settings wiring", () => {
	afterEach(async () => {
		await database.reset();
		database.seedUser(USER_ID);
	});

	test("model selection persists and reloads for a v2-only conversation", async () => {
		const conversation = await chatV2Repository.createConversation(USER_ID, {
			title: "New chat",
		});
		const rpc = caller();

		await rpc.conversation.setModel({
			id: conversation.id,
			provider: "openai",
			endpointId: "openai-default",
			modelId: "gpt-5.6",
			api: "openai-responses",
		});

		const effective = await rpc.model.forConversation({
			conversationId: conversation.id,
		});
		expect(effective.provider).toBe("openai");
		expect(effective.modelId).toBe("gpt-5.6");
	});

	test("reasoning effort and verbosity persist for a v2-only conversation", async () => {
		const conversation = await chatV2Repository.createConversation(USER_ID, {
			title: "New chat",
		});
		const rpc = caller();

		await rpc.conversation.setGenerationSettings({
			id: conversation.id,
			reasoningEffort: "high",
			verbosity: "low",
		});

		const effective = await rpc.model.forConversation({
			conversationId: conversation.id,
		});
		expect(effective.reasoningEffort).toBe("high");
		expect(effective.verbosity).toBe("low");
		expect(effective.effectiveReasoningEffort).toBe("high");
		expect(effective.effectiveVerbosity).toBe("low");
	});

	test("display mode persists for a v2-only conversation", async () => {
		const conversation = await chatV2Repository.createConversation(USER_ID, {
			title: "New chat",
		});
		const rpc = caller();

		await rpc.conversation.setDisplayMode({
			conversationId: conversation.id,
			displayMode: "timeline",
		});
		expect(
			(await rpc.conversation.getDisplayMode({ conversationId: conversation.id }))
				.displayMode,
		).toBe("timeline");
	});

	test("MCP server binding and auto-execute persist for a v2-only conversation", async () => {
		const conversation = await chatV2Repository.createConversation(USER_ID, {
			title: "New chat",
		});
		await database.db
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
		const rpc = caller();

		const before = await rpc.mcp.forConversation({
			conversationId: conversation.id,
		});
		expect(before.servers).toEqual([
			{ id: "server-1", name: "Shared server", enabled: true },
		]);
		expect(before.autoExecuteTools).toBe(true);

		await rpc.mcp.setConversation({
			conversationId: conversation.id,
			serverId: "server-1",
			enabled: false,
		});
		await rpc.mcp.setAutoExecute({
			conversationId: conversation.id,
			enabled: false,
		});

		const after = await rpc.mcp.forConversation({
			conversationId: conversation.id,
		});
		expect(after.servers).toEqual([
			{ id: "server-1", name: "Shared server", enabled: false },
		]);
		expect(after.autoExecuteTools).toBe(false);
	});

	test("settings procedures reject conversations owned by another user", async () => {
		const conversation = await chatV2Repository.createConversation(USER_ID, {
			title: "New chat",
		});
		const otherCaller = appRouter.createCaller({
			user: { id: "someone-else", role: "user" },
		} as never);
		await expect(
			otherCaller.conversation.setModel({
				id: conversation.id,
				provider: "openai",
				endpointId: "openai-default",
				modelId: "gpt-5.6",
				api: "openai-responses",
			}),
		).rejects.toThrow();
	});

	test("folder and tag endpoints create, list, assign, and delete against v2 tables", async () => {
		const conversation = await chatV2Repository.createConversation(USER_ID, {
			title: "New chat",
		});
		const rpc = caller();

		const folder = await rpc.folder.create({ name: "Work" });
		const tag = await rpc.tag.create({ name: "urgent" });
		expect(await rpc.folder.list()).toEqual([
			expect.objectContaining({ id: folder.id, name: "Work" }),
		]);
		expect(await rpc.tag.list()).toEqual([
			expect.objectContaining({ id: tag.id, name: "urgent" }),
		]);

		// Creating a tag with the same name reuses the existing tag.
		expect(await rpc.tag.create({ name: "urgent" })).toEqual({ id: tag.id });

		await rpc.conversation.move({ id: conversation.id, folderId: folder.id });
		await rpc.conversation.setTags({ id: conversation.id, tagIds: [tag.id] });
		expect(await rpc.conversation.list()).toEqual([
			expect.objectContaining({
				id: conversation.id,
				folderId: folder.id,
				tags: [{ id: tag.id, name: "urgent" }],
			}),
		]);

		await rpc.folder.rename({ id: folder.id, name: "Renamed" });
		expect(await rpc.folder.list()).toEqual([
			expect.objectContaining({ name: "Renamed" }),
		]);

		await rpc.folder.remove({ id: folder.id });
		expect(await rpc.folder.list()).toEqual([]);
		expect(
			(await rpc.conversation.list())[0]?.folderId,
		).toBeNull();

		await rpc.tag.remove({ id: tag.id });
		expect(await rpc.tag.list()).toEqual([]);
	});

	test("metrics records and sums provider call telemetry for a v2 conversation", async () => {
		const conversation = await chatV2Repository.createConversation(USER_ID, {
			title: "Metrics chat",
			provider: "mock",
			endpointId: "mock",
			modelId: "mock",
			modelApi: "mock",
		});
		const rpc = caller();

		// No usage recorded yet.
		expect(await rpc.conversation.metrics({ conversationId: conversation.id })).toMatchObject({
			contextTokens: null,
		});

		// Regression test: provider_call_telemetry previously had foreign keys
		// into the removed v1 conversation/message tables, so every insert with
		// a v2 conversation/turn id failed with SQLITE_CONSTRAINT_FOREIGNKEY.
		await database.db
			.insertInto("provider_call_telemetry")
			.values({
				id: "telemetry-1",
				conversationId: conversation.id,
				messageId: "not-a-real-turn-id",
				purpose: "chat",
				provider: "mock",
				api: "mock",
				modelId: "mock",
				inputTokens: 100,
				outputTokens: 20,
				cacheReadTokens: 0,
				estimatedCostMicros: 50,
			})
			.execute();

		const metrics = await rpc.conversation.metrics({ conversationId: conversation.id });
		expect(metrics.contextTokens).toBe(100);
		expect(metrics.costMicros).toBe(50);
	});

	test("folder and tag mutations reject ownership across users", async () => {
		const folder = await chatV2Repository.createFolder(USER_ID, { name: "Mine" });
		const tag = await chatV2Repository.createTag(USER_ID, { name: "mine" });
		const otherCaller = appRouter.createCaller({
			user: { id: "someone-else", role: "user" },
		} as never);

		await expect(
			otherCaller.folder.rename({ id: folder.id, name: "Hijacked" }),
		).rejects.toThrow();
		await expect(otherCaller.folder.remove({ id: folder.id })).rejects.toThrow();
		await expect(otherCaller.tag.remove({ id: tag.id })).rejects.toThrow();
	});
});
