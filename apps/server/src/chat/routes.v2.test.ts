import { beforeEach, describe, expect, mock, test } from "bun:test";

const calls: Array<{ name: string; input?: Record<string, unknown> }> = [];

mock.module("../auth", () => ({
	getSolarSession: async () => ({ user: { id: "v2-user", role: "user" } }),
}));
mock.module("./attachments", () => ({
	attachmentMetadata: async () => [],
	deleteAttachmentFilesForMessages: async () => {},
	linkAttachments: async () => {},
	loadAttachmentContentParts: async () => ({ parts: [], documents: [] }),
	loadAttachmentSummary: async () => "",
}));
mock.module("./catalog", () => ({
	MOCK: true,
	documentInputCapabilities: async () => ({ nativeMimeTypes: [], extractedTextMimeTypes: [] }),
	documentInputMimeTypes: async () => [],
	getModelCapabilities: async () => ({}),
	getTitlePrompt: async () => "",
	resolveSelection: async () => ({ provider: "mock", endpointId: "mock", modelId: "mock", api: "mock" }),
	resolveTaskModelOrFallback: async (selection: unknown) => selection,
	resolveModel: async () => {
		throw new Error("resolveModel should not be called when MOCK is true");
	},
	streamModel: () => {
		throw new Error("streamModel should not be called when MOCK is true");
	},
}));
mock.module("./generationManager", () => ({ generationManager: { start: () => {}, subscribe: () => new ReadableStream() } }));
mock.module("./tools", () => ({ toolProvider: { resolve: async () => [] } }));
mock.module("../context/runtime", () => ({ contextRuntime: { assemble: async () => ({ summary: null }) } }));
mock.module("./location", () => ({ reverseGeocode: async () => undefined }));
mock.module("../logger", () => ({ logger: { withMetadata: () => ({ trace: () => {} }) } }));
mock.module("./v2Live", () => ({
	chatV2Repository: {
		getTurn: async (_userId: string, turnId: string) => ({
			id: turnId,
			conversationId: "v2-conversation",
			role: turnId === "user-turn" ? "user" : "assistant",
		}),
		getAssistantTurnForUserTurn: async (_userId: string, userTurnId: string) => ({
			id: `${userTurnId}-assistant-reply`,
			conversationId: "v2-conversation",
			role: "assistant",
		}),
	},
	ownsAssistantTurn: async () => true,
	ownsConversation: async () => true,
	ownsUserTurn: async () => true,
	sendMessage: async () => "unused",
	editUserMessage: async (input: Record<string, unknown>) => {
		calls.push({ name: "edit", input });
		return "edited-assistant";
	},
	regenerateAssistantTurn: async (input: Record<string, unknown>) => {
		calls.push({ name: "regenerate", input });
		return "regenerated-assistant";
	},
	stopGeneration: async (_userId: string, messageId: string) => {
		calls.push({ name: "stop", input: { messageId } });
		return true;
	},
}));

const { chatRoutes } = await import("./routes");

describe("chat-v2 live edit routes", () => {
	beforeEach(() => calls.splice(0));

	test("edits and regenerates through the v2 live bridge when flagged", async () => {
		const edit = await chatRoutes.request("/edit", new Request("http://solar.local/edit", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ messageId: "user-turn", text: "Edited" }),
		}));
		expect(edit.status).toBe(202);
		expect(await edit.json()).toEqual({ messageId: "edited-assistant" });

		const regenerate = await chatRoutes.request("/regenerate", new Request("http://solar.local/regenerate", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ messageId: "assistant-turn" }),
		}));
		expect(regenerate.status).toBe(202);
		expect(await regenerate.json()).toEqual({ messageId: "regenerated-assistant" });
		expect(calls).toEqual([
			{ name: "edit", input: { userId: "v2-user", isAdmin: false, conversationId: "v2-conversation", targetTurnId: "user-turn", text: "Edited" } },
			{ name: "regenerate", input: { userId: "v2-user", isAdmin: false, conversationId: "v2-conversation", targetTurnId: "assistant-turn" } },
		]);
	});

	// assistant-ui's reload() passes the *parent* id of the assistant message
	// being reloaded, which is the preceding user turn, not the assistant turn.
	test("regenerate resolves a user turn id to its assistant reply", async () => {
		const regenerate = await chatRoutes.request("/regenerate", new Request("http://solar.local/regenerate", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ messageId: "user-turn" }),
		}));
		expect(regenerate.status).toBe(202);
		expect(await regenerate.json()).toEqual({ messageId: "regenerated-assistant" });
		expect(calls).toEqual([
			{ name: "regenerate", input: { userId: "v2-user", isAdmin: false, conversationId: "v2-conversation", targetTurnId: "user-turn-assistant-reply" } },
		]);
	});

	test("stops and force-stops through v2 durable generation handling when flagged", async () => {
		for (const path of ["/stop", "/force-stop"]) {
			const response = await chatRoutes.request(path, new Request(`http://solar.local${path}`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ messageId: "assistant-turn" }),
			}));
			expect(response.status).toBe(200);
			expect(await response.json()).toEqual({ stopped: true });
		}
		expect(calls).toEqual([
			{ name: "stop", input: { messageId: "assistant-turn" } },
			{ name: "stop", input: { messageId: "assistant-turn" } },
		]);
	});
});
