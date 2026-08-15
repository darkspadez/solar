import { afterEach, describe, expect, test } from "bun:test";
import type { AssistantMessage, Message } from "@earendil-works/pi-ai";
import { CompactionService } from "./compaction";
import { enqueueCompactionForCompletedGeneration } from "./compactionScheduler";
import { materializeContext } from "./context";
import { createV2TestDatabase } from "./db/fixtures";
import { ChatV2Repository } from "./db/repository";
import { zeroUsage } from "./validation";

const USER_ID = "scheduler-user";
const CONVERSATION_ID = "scheduler-conversation";

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

describe("chat-v2 compaction scheduler", () => {
	const databases: Awaited<ReturnType<typeof createV2TestDatabase>>[] = [];

	afterEach(async () => {
		await Promise.all(databases.splice(0).map((database) => database.destroy()));
	});

	test("queues and materializes completed history without touching v1 tables", async () => {
		const database = await createV2TestDatabase();
		databases.push(database);
		database.seedUser(USER_ID);
		const repository = new ChatV2Repository(database.db);
		await repository.createConversation(USER_ID, {
			id: CONVERSATION_ID,
			title: "Scheduled compaction",
		});

		const messages: Message[] = [
			{ role: "user", content: "first question", timestamp: 1 },
			assistant("first answer"),
			{ role: "user", content: "second question", timestamp: 2 },
			assistant("second answer"),
		];
		for (const [ordinal, message] of messages.entries()) {
			const turnId = `turn-${ordinal}`;
			await repository.createTurn(USER_ID, CONVERSATION_ID, {
				id: turnId,
				ordinal,
				role: message.role === "user" ? "user" : "assistant",
				origin: "text",
				status: "complete",
			});
			await repository.appendCanonicalMessages(USER_ID, CONVERSATION_ID, [{
				id: `message-${ordinal}`,
				turnId,
				message,
				origin: "text",
				status: "complete",
			}]);
		}

		const tightPolicy = { enabled: true, softTriggerTokens: 0, targetTokens: 0 };
		const jobId = await enqueueCompactionForCompletedGeneration(
			repository,
			USER_ID,
			CONVERSATION_ID,
			tightPolicy,
		);
		expect(jobId).toBeString();
		expect(
			await enqueueCompactionForCompletedGeneration(repository, USER_ID, CONVERSATION_ID, tightPolicy),
		).toBeNull();

		const artifact = await new CompactionService(repository).run(
			USER_ID,
			jobId!,
			async () => "The first exchange was resolved.",
		);
		expect(artifact).not.toBe("stale");
		const canonical = await repository.listCanonicalMessages(USER_ID, CONVERSATION_ID);
		const context = materializeContext(
			CONVERSATION_ID,
			canonical,
			await repository.listCompactions(USER_ID, CONVERSATION_ID),
		);
		expect(context.manifest.messageIds).toEqual(["message-2", "message-3"]);
		expect(context.manifest.compactionIds).toEqual([
			artifact === "stale" ? "" : artifact.id,
		]);
		expect(context.context).toHaveLength(3);
		expect(
			database.sqlite.query("select name from sqlite_master where name = 'conversation'").all(),
		).toEqual([]);
	});

	test("does not trigger compaction while under the configured token budget", async () => {
		const database = await createV2TestDatabase();
		databases.push(database);
		database.seedUser(USER_ID);
		const repository = new ChatV2Repository(database.db);
		await repository.createConversation(USER_ID, {
			id: CONVERSATION_ID,
			title: "Realistic policy",
		});

		// Small conversation with a realistic model token budget — this used to
		// trigger compaction after just 4 messages regardless of actual token
		// usage, which summarized context far too early.
		const messages: Message[] = [
			{ role: "user", content: "first question", timestamp: 1 },
			assistant("first answer"),
			{ role: "user", content: "second question", timestamp: 2 },
			assistant("second answer"),
		];
		for (const [ordinal, message] of messages.entries()) {
			const turnId = `turn-${ordinal}`;
			await repository.createTurn(USER_ID, CONVERSATION_ID, {
				id: turnId,
				ordinal,
				role: message.role === "user" ? "user" : "assistant",
				origin: "text",
				status: "complete",
			});
			await repository.appendCanonicalMessages(USER_ID, CONVERSATION_ID, [{
				id: `message-${ordinal}`,
				turnId,
				message,
				origin: "text",
				status: "complete",
			}]);
		}

		const realisticPolicy = {
			enabled: true,
			softTriggerTokens: 240_000,
			targetTokens: 180_000,
		};
		expect(
			await enqueueCompactionForCompletedGeneration(
				repository,
				USER_ID,
				CONVERSATION_ID,
				realisticPolicy,
			),
		).toBeNull();
	});

	test("never triggers when the policy is disabled", async () => {
		const database = await createV2TestDatabase();
		databases.push(database);
		database.seedUser(USER_ID);
		const repository = new ChatV2Repository(database.db);
		await repository.createConversation(USER_ID, {
			id: CONVERSATION_ID,
			title: "Disabled policy",
		});
		const messages: Message[] = [
			{ role: "user", content: "first question", timestamp: 1 },
			assistant("first answer"),
			{ role: "user", content: "second question", timestamp: 2 },
			assistant("second answer"),
		];
		for (const [ordinal, message] of messages.entries()) {
			const turnId = `turn-${ordinal}`;
			await repository.createTurn(USER_ID, CONVERSATION_ID, {
				id: turnId,
				ordinal,
				role: message.role === "user" ? "user" : "assistant",
				origin: "text",
				status: "complete",
			});
			await repository.appendCanonicalMessages(USER_ID, CONVERSATION_ID, [{
				id: `message-${ordinal}`,
				turnId,
				message,
				origin: "text",
				status: "complete",
			}]);
		}
		expect(
			await enqueueCompactionForCompletedGeneration(repository, USER_ID, CONVERSATION_ID, {
				enabled: false,
				softTriggerTokens: 0,
				targetTokens: 0,
			}),
		).toBeNull();
	});

	test("triggers compaction using real upstream usage when character estimation is low", async () => {
		const database = await createV2TestDatabase();
		databases.push(database);
		database.seedUser(USER_ID);
		const repository = new ChatV2Repository(database.db);
		await repository.createConversation(USER_ID, {
			id: CONVERSATION_ID,
			title: "Upstream usage compaction",
		});

		// Short messages (few chars), but assistant has high upstream token usage
		const assistant1: AssistantMessage = {
			...assistant("short answer 1"),
			usage: {
				...zeroUsage(),
				input: 50_000,
				output: 10_000,
				totalTokens: 60_000,
			},
		};
		const assistant2: AssistantMessage = {
			...assistant("short answer 2"),
			usage: {
				...zeroUsage(),
				input: 280_000,
				output: 15_000,
				totalTokens: 295_000,
			},
		};
		const messages: Message[] = [
			{ role: "user", content: "first question", timestamp: 1 },
			assistant1,
			{ role: "user", content: "second question", timestamp: 2 },
			assistant2,
		];
		for (const [ordinal, message] of messages.entries()) {
			const turnId = `turn-${ordinal}`;
			await repository.createTurn(USER_ID, CONVERSATION_ID, {
				id: turnId,
				ordinal,
				role: message.role === "user" ? "user" : "assistant",
				origin: "text",
				status: "complete",
			});
			await repository.appendCanonicalMessages(USER_ID, CONVERSATION_ID, [
				{
					id: `message-${ordinal}`,
					turnId,
					message,
					origin: "text",
					status: "complete",
				},
			]);
		}

		// Policy triggers at 250k. Local char heuristic is only ~20 tokens, but upstream is 295k
		const policy = {
			enabled: true,
			softTriggerTokens: 250_000,
			targetTokens: 100_000,
		};
		const jobId = await enqueueCompactionForCompletedGeneration(
			repository,
			USER_ID,
			CONVERSATION_ID,
			policy,
		);
		expect(jobId).toBeString();
	});
});
