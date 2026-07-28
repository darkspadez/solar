import { afterEach, describe, expect, mock, test } from "bun:test";
import type { AssistantMessage, Message } from "@earendil-works/pi-ai";
import { createV2TestDatabase } from "../chat-v2/db/fixtures";
import { ChatV2Repository } from "../chat-v2/db/repository";
import { zeroUsage } from "../chat-v2/validation";

const USER_ID = "compaction-live-user";

const database = await createV2TestDatabase();
database.seedUser(USER_ID);

mock.module("../db", () => ({ db: database.db }));
mock.module("./catalog", () => ({
	MOCK: true,
	resolveSelection: async () => ({
		provider: "acme",
		endpointId: "acme-default",
		modelId: "acme-model",
		api: "openai-responses",
	}),
	resolveTaskModelOrFallback: async (selection: unknown) => selection,
	// A tight, always-triggering policy so this test can assert wiring
	// (enqueue + run happen synchronously after persist) without depending
	// on real token thresholds, which are covered by compactionScheduler.test.ts.
	resolveModel: async () => ({
		model: { contextWindow: 128_000 },
		contextPolicy: {
			enabled: true,
			softTriggerTokens: 0,
			targetTokens: 0,
			hardInputTokens: 0,
			maxPinnedAttachmentTokens: 0,
			outputReserveTokens: 0,
		},
	}),
	streamModel: () => {
		throw new Error("streamModel should not be called in this test");
	},
	getModelCapabilities: async () => ({
		reasoningLevels: [],
		supportsVerbosity: false,
		defaultReasoningEffort: null,
		defaultVerbosity: null,
	}),
	getTitlePrompt: async () => "{{first_message}}",
	documentInputCapabilities: async () => ({ nativeMimeTypes: [], extractedTextMimeTypes: [] }),
	listAvailableModels: async () => [],
}));
mock.module("./tools", () => ({ toolProvider: { resolve: async () => [] } }));
mock.module("./attachments", () => ({
	expandAttachmentRows: async () => ({ parts: [], documents: [] }),
	deleteAttachmentFilesByStorageKey: async () => {},
}));
mock.module("./builtins", () => ({ renderBuiltinPromptInterpolations: (prompt: string | null) => prompt }));

let generationOptions: { persist?: (result: { steps: unknown[]; parts: unknown; status: string; text: string }) => Promise<void> } | undefined;
mock.module("./generationManager", () => ({
	generationManager: {
		start: (opts: typeof generationOptions) => {
			generationOptions = opts;
		},
		isActive: () => false,
		stop: () => false,
	},
}));

const { chatV2Repository, sendMessage } = await import("./v2Live");

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

async function waitFor(check: () => Promise<boolean>, timeoutMs = 2000): Promise<void> {
	const start = Date.now();
	while (Date.now() - start < timeoutMs) {
		if (await check()) return;
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
	throw new Error("condition not met before timeout");
}

describe("chat-v2 live compaction wiring", () => {
	afterEach(async () => {
		await database.destroy();
	});

	test("runs (not just enqueues) a compaction job immediately after a generation completes", async () => {
		const repository = chatV2Repository as ChatV2Repository;
		const conversationId = "compaction-live-conversation";
		await repository.createConversation(USER_ID, { id: conversationId, title: "Live compaction" });

		const priorMessages: Message[] = [
			{ role: "user", content: "first question", timestamp: 1 },
			assistant("first answer"),
			{ role: "user", content: "second question", timestamp: 2 },
			assistant("second answer"),
		];
		for (const [ordinal, message] of priorMessages.entries()) {
			const turnId = `prior-turn-${ordinal}`;
			await repository.createTurn(USER_ID, conversationId, {
				id: turnId,
				ordinal,
				role: message.role === "user" ? "user" : "assistant",
				origin: "text",
				status: "complete",
			});
			await repository.appendCanonicalMessages(USER_ID, conversationId, [{
				id: `prior-message-${ordinal}`,
				turnId,
				message,
				origin: "text",
				status: "complete",
			}]);
		}

		await sendMessage({
			userId: USER_ID,
			isAdmin: false,
			conversationId,
			text: "third question",
		});

		expect(generationOptions?.persist).toBeFunction();
		await generationOptions!.persist!({
			steps: [],
			parts: assistant("third answer"),
			status: "complete",
			text: "third answer",
		});

		// No manual `.run()` call here: the wiring under test must enqueue and
		// execute the compaction job on its own, immediately.
		await waitFor(async () => (await repository.listCompactions(USER_ID, conversationId)).length > 0);

		const compactions = await repository.listCompactions(USER_ID, conversationId);
		expect(compactions).toHaveLength(1);
		const jobs = await repository.listCompactionJobs(USER_ID, conversationId);
		expect(jobs.every((job) => job.status === "complete")).toBe(true);
	});
});
