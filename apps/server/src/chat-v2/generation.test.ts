import { afterEach, describe, expect, test } from "bun:test";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { materializeContext } from "./context";
import { plainTextExchange } from "./fixtures";
import { GenerationService } from "./generation";
import { zeroUsage } from "./validation";
import { createV2TestDatabase } from "./db/fixtures";
import { ChatV2Repository } from "./db/repository";

const USER_ID = "generation-user";
const CONVERSATION_ID = "generation-conversation";

describe("chat-v2 generation lifecycle", () => {
	const databases: Awaited<ReturnType<typeof createV2TestDatabase>>[] = [];

	afterEach(async () => {
		await Promise.all(databases.splice(0).map((database) => database.destroy()));
	});

	async function setup() {
		const database = await createV2TestDatabase();
		databases.push(database);
		database.seedUser(USER_ID);
		const repository = new ChatV2Repository(database.db);
		await repository.createConversation(USER_ID, { id: CONVERSATION_ID, title: "Generation" });
		await repository.createTurn(USER_ID, CONVERSATION_ID, { id: "assistant-turn", ordinal: 0, role: "assistant", origin: "text", status: "pending" });
		return { database, repository, service: new GenerationService(repository) };
	}

	async function start(service: GenerationService, id: string, status: "queued" | "running" = "running") {
		return service.startGeneration({ userId: USER_ID, conversationId: CONVERSATION_ID, turnId: "assistant-turn", id, status, provider: "fixture", api: "openai-completions", model: "fixture-model", request: { messages: [] } });
	}

	function output(id = "assistant-message") {
		return [{ id, turnId: "assistant-turn", message: plainTextExchange()[1]!, origin: "text" as const, status: "complete" as const }];
	}

	test("completion survives a disconnect because it has no connection dependency", async () => {
		const { repository, service } = await setup();
		await start(service, "generation-disconnect");
		const unsubscribe = service.subscribe(() => undefined);
		unsubscribe(); // Simulated disconnected SSE client.
		expect(await service.completeGeneration(USER_ID, "generation-disconnect", output(), zeroUsage(), "stop")).toBe(true);
		expect((await repository.getGeneration(USER_ID, "generation-disconnect")).status).toBe("complete");
		expect((await repository.listCanonicalMessages(USER_ID, CONVERSATION_ID)).map((record) => record.id)).toEqual(["assistant-message"]);
	});

	test("checkpoints are monotonic and Stop preserves the latest partial message", async () => {
		const { database, repository, service } = await setup();
		database.sqlite.exec("create table message (id text primary key, text text not null)");
		database.sqlite.query("insert into message values (?, ?)").run("v1-message", "unchanged");
		await start(service, "generation-stop", "queued");
		const partial = { ...plainTextExchange()[1]! as AssistantMessage, content: [{ type: "text" as const, text: "Partial" }] };
		await service.appendGenerationCheckpoint(USER_ID, "generation-stop", { message: partial });
		await service.appendGenerationCheckpoint(USER_ID, "generation-stop", { message: { ...partial, content: [{ type: "text", text: "Partial response" }] } });
		expect(await service.stopGeneration(USER_ID, "generation-stop")).toBe(true);
		const generation = await repository.getGeneration(USER_ID, "generation-stop");
		expect(generation).toMatchObject({ status: "stopped", partialMessageJson: JSON.stringify({ ...partial, content: [{ type: "text", text: "Partial response" }] }) });
		expect((await repository.listGenerationEvents(USER_ID, "generation-stop")).map((event) => event.sequence)).toEqual([0, 1, 2]);
		expect(database.sqlite.query("select * from message").all()).toEqual([
			{ id: "v1-message", text: "unchanged" },
		]);
	});

	test("failure adds no canonical garbage and later context remains valid", async () => {
		const { repository, service } = await setup();
		await start(service, "generation-fail");
		await service.appendGenerationCheckpoint(USER_ID, "generation-fail", { message: plainTextExchange()[1]! });
		expect(await service.failGeneration(USER_ID, "generation-fail", new Error("provider unavailable"))).toBe(true);
		expect(await repository.listCanonicalMessages(USER_ID, CONVERSATION_ID)).toEqual([]);
		expect((await repository.getGeneration(USER_ID, "generation-fail")).errorMessage).toBe("provider unavailable");
		expect(materializeContext(CONVERSATION_ID, await repository.listCanonicalMessages(USER_ID, CONVERSATION_ID), []).context).toEqual([]);
	});

	test("duplicate completion is a no-op without duplicate canonical messages", async () => {
		const { repository, service } = await setup();
		await start(service, "generation-idempotent");
		expect(await service.completeGeneration(USER_ID, "generation-idempotent", output(), zeroUsage(), "stop")).toBe(true);
		expect(await service.completeGeneration(USER_ID, "generation-idempotent", output(), zeroUsage(), "stop")).toBe(false);
		expect(await repository.listCanonicalMessages(USER_ID, CONVERSATION_ID)).toHaveLength(1);
	});

	test("startup reconciliation marks abandoned running work interrupted without fabricating a response", async () => {
		const { repository, service } = await setup();
		await start(service, "generation-restart");
		expect(await service.reconcileRunningGenerations(USER_ID)).toBe(1);
		expect(await repository.getGeneration(USER_ID, "generation-restart")).toMatchObject({ status: "interrupted", partialMessageJson: null });
		expect(await repository.listCanonicalMessages(USER_ID, CONVERSATION_ID)).toEqual([]);
	});
});
