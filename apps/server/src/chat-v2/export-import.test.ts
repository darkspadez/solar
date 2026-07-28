import { afterEach, describe, expect, test } from "bun:test";
import type { Message } from "@earendil-works/pi-ai";
import { CompactionService } from "./compaction";
import { listChatV2OperationalDiagnostics } from "./diagnostics";
import { ChatV2ExportService } from "./export";
import { ChatV2ImportService, ChatV2ImportValidationError } from "./import";
import { checkChatV2Integrity } from "./integrity";
import { projectVisibleTurns } from "./projection";
import { rebuildSearchProjection } from "./search";
import { createV2TestDatabase } from "./db/fixtures";
import { ChatV2Repository } from "./db/repository";
import { plainTextExchange, toolCallResultContinuation, voiceTranscriptPair } from "./fixtures";

const SOURCE = "export-source";
const TARGET = "import-target";

describe("chat-v2 export and import", () => {
	const databases: Awaited<ReturnType<typeof createV2TestDatabase>>[] = [];

	afterEach(async () => {
		await Promise.all(databases.splice(0).map((database) => database.destroy()));
	});

	async function setup(messages: readonly Message[], options: { voice?: boolean; attachment?: boolean; compaction?: boolean } = {}) {
		const database = await createV2TestDatabase();
		databases.push(database);
		database.seedUser(SOURCE);
		database.seedUser(TARGET);
		const repository = new ChatV2Repository(database.db);
		await repository.createFolder(SOURCE, { id: "folder", name: "Exports" });
		await repository.createTag(SOURCE, { id: "tag", name: "round-trip" });
		await repository.createConversation(SOURCE, { id: "conversation", title: "Portable history" });
		await repository.setConversationFolder(SOURCE, "conversation", "folder");
		await repository.setConversationTags(SOURCE, "conversation", ["tag"]);
		let turnOrdinal = 0;
		let assistantTurn: string | null = null;
		const inputs = [];
		for (const [index, message] of messages.entries()) {
			let turnId: string | null = assistantTurn;
			if (message.role === "user" || !turnId) {
				turnId = `turn-${turnOrdinal}`;
				await repository.createTurn(SOURCE, "conversation", { id: turnId, ordinal: turnOrdinal, role: message.role === "user" ? "user" : "assistant", origin: options.voice ? "voice" : "text", status: "complete" });
				turnOrdinal += 1;
			}
			assistantTurn = message.role === "user" ? null : turnId;
			inputs.push({ id: `message-${index}`, turnId, message, origin: options.voice ? "voice" as const : "text" as const, status: "complete" as const });
		}
		await repository.appendCanonicalMessages(SOURCE, "conversation", inputs);
		if (options.attachment) {
			await repository.createAttachment(SOURCE, { id: "attachment", storageKey: "assets/note.txt", filename: "note.txt", mimeType: "text/plain", kind: "text", byteSize: 4, sha256: "hash" });
			await repository.bindAttachment(SOURCE, "conversation", "message-0", "attachment", 0);
		}
		if (options.compaction) {
			const service = new CompactionService(repository);
			const job = await service.enqueue(SOURCE, "conversation", { firstMessageId: "message-0", lastMessageId: "message-1" });
			await service.run(SOURCE, job.id, async () => "Portable greeting summary.");
		}
		return { database, repository };
	}

	test("round-trips text, tool, voice, attachment, and compacted histories with rebuilt projections", async () => {
		const scenarios: Array<{ messages: Message[]; options: { voice?: boolean; attachment?: boolean; compaction?: boolean } }> = [
			{ messages: plainTextExchange(), options: {} },
			{ messages: toolCallResultContinuation(), options: {} },
			{ messages: voiceTranscriptPair(), options: { voice: true } },
			{ messages: plainTextExchange(), options: { attachment: true } },
			{ messages: plainTextExchange(), options: { compaction: true } },
		];
		for (const scenario of scenarios) {
			const { database, repository } = await setup(scenario.messages, scenario.options);
			const bundle = await new ChatV2ExportService(database.db, repository).build(SOURCE, "conversation");
			const importer = new ChatV2ImportService(database.db);
			const plan = await importer.plan(bundle, TARGET, { remap: true });
			const imported = await importer.execute(plan);
			const source = await repository.listCanonicalMessages(SOURCE, "conversation");
			const target = await repository.listCanonicalMessages(TARGET, imported.conversationId);
			expect(target.map((record) => record.message)).toEqual(source.map((record) => record.message));
			expect(projectVisibleTurns(target).map((turn) => ({ role: turn.role, origin: turn.origin, displayText: turn.displayText, messages: turn.messages.map((message) => message.message) }))).toEqual(projectVisibleTurns(source).map((turn) => ({ role: turn.role, origin: turn.origin, displayText: turn.displayText, messages: turn.messages.map((message) => message.message) })));
			expect(rebuildSearchProjection(target).map((entry) => entry.text)).toEqual(rebuildSearchProjection(source).map((entry) => entry.text));
			if (scenario.options.attachment) {
				expect(plan.warnings).toContainEqual(expect.objectContaining({ code: "attachment_bytes_unavailable" }));
				expect(await repository.listMessageAttachments(TARGET, imported.conversationId)).toHaveLength(1);
			}
			if (scenario.options.compaction) expect(await repository.listCompactions(TARGET, imported.conversationId)).toHaveLength(1);
		}
	});

	test("rejects broken tool relationships, cross-user ownership without remap, and target collisions", async () => {
		const { database, repository } = await setup(toolCallResultContinuation());
		const exporter = new ChatV2ExportService(database.db, repository);
		const bundle = await exporter.build(SOURCE, "conversation");
		const importer = new ChatV2ImportService(database.db);
		await expect(importer.plan(bundle, TARGET)).rejects.toBeInstanceOf(ChatV2ImportValidationError);
		await expect(importer.plan(bundle, SOURCE)).rejects.toThrow("target ID collision");
		bundle.messages = bundle.messages.filter((message) => message.id !== "message-1").map((message, ordinal) => ({ ...message, ordinal }));
		await expect(importer.plan(bundle, TARGET, { remap: true })).rejects.toThrow("tool result weather-1 has no preceding tool call");
	});

	test("drops mismatched compactions and exposes failed/stale jobs plus database validation", async () => {
		const { database, repository } = await setup(plainTextExchange(), { compaction: true });
		const exporter = new ChatV2ExportService(database.db, repository);
		const bundle = await exporter.build(SOURCE, "conversation");
		bundle.compactions![0]!.sourceHash = "wrong";
		const plan = await new ChatV2ImportService(database.db).plan(bundle, TARGET, { remap: true });
		expect(plan.validCompactionIds).toEqual([]);
		expect(plan.warnings).toContainEqual(expect.objectContaining({ code: "compaction_dropped" }));
		await repository.createGeneration(SOURCE, "conversation", { id: "failed", status: "failed", provider: "fixture", api: "openai-completions", model: "fixture", requestJson: "{}" });
		await database.db.insertInto("v2_context_compaction_job").values({ id: "stale", conversationId: "conversation", firstMessageId: "message-0", lastMessageId: "message-1", sourceHash: "hash", status: "stale", compactionId: null, errorMessage: null, createdAt: new Date().toISOString(), finishedAt: new Date().toISOString() }).execute();
		expect((await listChatV2OperationalDiagnostics(database.db, SOURCE)).failedGenerations.map((item) => item.id)).toEqual(["failed"]);
		expect((await listChatV2OperationalDiagnostics(database.db)).staleCompactionJobs.map((item) => item.id)).toEqual(["stale"]);
		expect(await checkChatV2Integrity(database.db)).toMatchObject({ integrity: ["ok"], foreignKeyViolations: [], messageValidationErrors: [] });
	});
});
