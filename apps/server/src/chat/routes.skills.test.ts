import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { createV2TestDatabase } from "../chat-v2/db/fixtures";

const skillContent = `---
name: release-notes
description: Draft release notes.
---
# Release notes
`;

const USER_ID = "owner";
const database = await createV2TestDatabase();
database.seedUser(USER_ID);

mock.module("../auth", () => ({
	getSolarSession: async () => ({ user: { id: USER_ID, role: "user" } }),
}));
mock.module("../db", () => ({ db: database.db, sqlite: database.sqlite }));
mock.module("./attachments", () => ({
	attachmentMetadata: async () => [],
	deleteAttachmentFilesForMessages: async () => {},
	deleteAttachmentFilesByStorageKey: async () => {},
	linkAttachments: async () => {},
	loadAttachmentContentParts: async () => ({ parts: [], documents: [] }),
	loadAttachmentSummary: async () => "",
	expandAttachmentRows: async () => ({ parts: [], documents: [] }),
}));
mock.module("./catalog", () => ({
	MOCK: true,
	documentInputCapabilities: async () => ({
		nativeMimeTypes: [],
		extractedTextMimeTypes: [],
	}),
	documentInputMimeTypes: async () => [],
	getModelCapabilities: async () => ({
		reasoningLevels: [],
		supportsVerbosity: false,
		defaultReasoningEffort: null,
		defaultVerbosity: null,
	}),
	listAvailableModels: async () => [],
	getTitlePrompt: async () => "",
	resolveSelection: async () => ({
		provider: "mock",
		endpointId: "mock",
		modelId: "mock",
		api: "mock",
	}),
	resolveTaskModelOrFallback: async (selection: unknown) => selection,
	resolveModel: async () => {
		throw new Error("resolveModel should not be called when MOCK is true");
	},
	streamModel: () => {
		throw new Error("streamModel should not be called when MOCK is true");
	},
}));
let startedGeneration: { context: unknown; persist?: (result: unknown) => Promise<void> } | undefined;
mock.module("./generationManager", () => ({
	generationManager: {
		start: (opts: typeof startedGeneration) => {
			startedGeneration = opts;
		},
	},
}));
mock.module("./tools", () => ({ toolProvider: { resolve: async () => [] } }));
mock.module("./location", () => ({ reverseGeocode: async () => undefined }));
mock.module("../logger", () => ({
	logger: {
		withMetadata: () => ({ trace: () => {}, debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }),
		withError: () => ({ withMetadata: () => ({ warn: () => {}, error: () => {} }) }),
	},
}));

const { chatRoutes } = await import("./routes");
const { chatV2Repository } = await import("./v2Live");

describe("skill chat POST", () => {
	let conversationId: string;

	beforeEach(async () => {
		startedGeneration = undefined;
		const conversation = await chatV2Repository.createConversation(USER_ID, { title: "Chat" });
		conversationId = conversation.id;
		await database.db
			.insertInto("skill")
			.values({
				id: crypto.randomUUID(),
				userId: USER_ID,
				name: "release-notes",
				description: "Draft release notes.",
				content: skillContent,
				exposed: 1,
			})
			.execute();
	});

	afterEach(async () => {
		await database.reset();
		database.seedUser(USER_ID);
	});

	test("persists a hidden explicit skill invocation with the ordinary user text", async () => {
		const response = await chatRoutes.request(
			"/",
			new Request("http://solar.local/", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					conversationId,
					skillName: "release-notes",
					text: "prepare the patch",
				}),
			}),
		);

		expect(response.status).toBe(202);
		const messages = await chatV2Repository.listCanonicalMessages(USER_ID, conversationId);
		const userMessage = messages.find((message) => message.message.role === "user");
		expect(userMessage).toBeDefined();
		const content = userMessage!.message.role === "user" ? userMessage!.message.content : undefined;
		const text = typeof content === "string"
			? content
			: content?.filter((part) => part.type === "text").map((part) => part.text).join("\n");
		expect(text).toContain("prepare the patch");
		expect(text).toContain(skillContent);
	});

	test("rejects malformed skill names before querying or persisting", async () => {
		const response = await chatRoutes.request(
			"/",
			new Request("http://solar.local/", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					conversationId,
					skillName: "Release Notes",
					text: "prepare the patch",
				}),
			}),
		);

		expect(response.status).toBe(400);
		expect(
			(await chatV2Repository.listCanonicalMessages(USER_ID, conversationId)).length,
		).toBe(0);
	});
});
