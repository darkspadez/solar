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

		const jobId = await enqueueCompactionForCompletedGeneration(
			repository,
			USER_ID,
			CONVERSATION_ID,
		);
		expect(jobId).toBeString();
		expect(await enqueueCompactionForCompletedGeneration(repository, USER_ID, CONVERSATION_ID)).toBeNull();

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
});
