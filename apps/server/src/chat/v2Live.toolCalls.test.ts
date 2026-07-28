import { afterEach, describe, expect, mock, test } from "bun:test";
import type { AssistantMessage, Message, ToolResultMessage } from "@earendil-works/pi-ai";
import { createV2TestDatabase } from "../chat-v2/db/fixtures";
import { ChatV2Repository } from "../chat-v2/db/repository";
import { zeroUsage } from "../chat-v2/validation";

const USER_ID = "tool-calls-user";

const database = await createV2TestDatabase();
database.seedUser(USER_ID);

mock.module("../db", () => ({ db: database.db }));
mock.module("./generationManager", () => ({
	generationManager: { isActive: () => false },
}));
// v2Live.ts imports these at module scope; mock them (matching
// v2Live.compaction.test.ts's pattern) so a real `DiskResource` is never
// constructed for a test that never touches attachment storage.
mock.module("./attachments", () => ({
	expandAttachmentRows: async () => ({ parts: [], documents: [] }),
	deleteAttachmentFilesByStorageKey: async () => {},
}));

const { chatV2Repository, loadMessages } = await import("./v2Live");

function assistant(content: AssistantMessage["content"]): AssistantMessage {
	return {
		role: "assistant",
		content,
		timestamp: Date.now(),
		provider: "mock",
		api: "openai-completions",
		model: "mock",
		usage: zeroUsage(),
		stopReason: "stop",
	};
}

describe("chat-v2 loadMessages tool-call reconstruction", () => {
	afterEach(async () => {
		await database.destroy();
	});

	test("rebuilds tool-call chips (with server/remote display names) after a reload", async () => {
		const repository = chatV2Repository as ChatV2Repository;
		const conversationId = "tool-calls-conversation";
		await repository.createConversation(USER_ID, { id: conversationId, title: "Tool calls" });
		await database.db
			.insertInto("mcp_server")
			.values({
				id: "0d494056-1a19-42d6-81bb-af5a5a6d94bb",
				userId: null,
				name: "Exa",
				url: "https://example.com/mcp",
				headers: "{}",
				enabled: 1,
				createdAt: new Date().toISOString(),
				updatedAt: new Date().toISOString(),
			})
			.execute();

		await repository.createTurn(USER_ID, conversationId, {
			id: "user-turn",
			ordinal: 0,
			role: "user",
			origin: "text",
			status: "complete",
		});
		await repository.appendCanonicalMessages(USER_ID, conversationId, [
			{
				id: "user-message",
				turnId: "user-turn",
				message: { role: "user", content: "Search for something", timestamp: 1 },
				origin: "text",
				status: "complete",
			},
		]);

		const toolCallId = "call-1";
		const toolResult: ToolResultMessage = {
			role: "toolResult",
			toolCallId,
			toolName: "mcp_0d494056_1a19_42d6_81bb_af5a5a6d94bb_web_search_exa",
			content: [{ type: "text", text: '{"content":[{"type":"text","text":"raw result"}]}' }],
			isError: false,
			timestamp: 2,
		};
		const messages: Message[] = [
			assistant([
				{
					type: "toolCall",
					id: toolCallId,
					name: "mcp_0d494056_1a19_42d6_81bb_af5a5a6d94bb_web_search_exa",
					arguments: { query: "something" },
				},
			]),
			toolResult,
			assistant([{ type: "text", text: "Here is the answer." }]),
		];
		await repository.createTurn(USER_ID, conversationId, {
			id: "assistant-turn",
			ordinal: 1,
			role: "assistant",
			origin: "text",
			status: "complete",
		});
		await repository.appendCanonicalMessages(
			USER_ID,
			conversationId,
			messages.map((message, index) => ({
				id: `assistant-message-${index}`,
				turnId: "assistant-turn",
				message,
				origin: "text" as const,
				status: "complete" as const,
			})),
		);

		const loaded = await loadMessages(USER_ID, conversationId);
		const assistantTurn = loaded.find((turn) => turn.id === "assistant-turn");
		expect(assistantTurn?.toolCalls).toEqual([
			{
				id: toolCallId,
				name: "mcp_0d494056_1a19_42d6_81bb_af5a5a6d94bb_web_search_exa",
				args: JSON.stringify({ query: "something" }),
				status: "complete",
				output: '{"content":[{"type":"text","text":"raw result"}]}',
				serverName: "Exa",
				remoteName: "web_search_exa",
			},
		]);
		expect(assistantTurn?.text).toBe("Here is the answer.");
	});
});
