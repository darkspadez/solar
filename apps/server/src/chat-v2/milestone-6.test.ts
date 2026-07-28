import { afterEach, describe, expect, test } from "bun:test";
import type { AttachmentRecord } from "./types";
import { AttachmentService } from "./attachments";
import { materializeContext } from "./context";
import { createV2TestDatabase } from "./db/fixtures";
import { ChatV2Repository, V2NotFoundError } from "./db/repository";
import { toolCallResultContinuation } from "./fixtures";
import { projectVisibleTurns } from "./projection";
import { rebuildSearchProjection, searchProjection } from "./search";

const USER_A = "m6-user-a";
const USER_B = "m6-user-b";
const CONVERSATION_ID = "m6-conversation";

describe("chat-v2 M6 attachments, projections, search, and organization", () => {
	const databases: Awaited<ReturnType<typeof createV2TestDatabase>>[] = [];

	afterEach(async () => {
		await Promise.all(databases.splice(0).map((database) => database.destroy()));
	});

	async function setup() {
		const database = await createV2TestDatabase();
		databases.push(database);
		database.seedUser(USER_A);
		database.seedUser(USER_B);
		const repository = new ChatV2Repository(database.db);
		await repository.createConversation(USER_A, { id: CONVERSATION_ID, title: "Original title" });
		await repository.createTurn(USER_A, CONVERSATION_ID, { id: "user-turn", ordinal: 0, role: "user", origin: "text", status: "complete" });
		await repository.createTurn(USER_A, CONVERSATION_ID, { id: "assistant-turn", ordinal: 1, role: "assistant", origin: "text", status: "complete" });
		const [user, ...assistant] = toolCallResultContinuation();
		await repository.appendCanonicalMessages(USER_A, CONVERSATION_ID, [
			{ id: "user-message", turnId: "user-turn", message: user!, origin: "text", status: "complete" },
			...assistant.map((message, index) => ({ id: `assistant-message-${index}`, turnId: "assistant-turn", message, origin: "text" as const, status: "complete" as const })),
		]);
		return { database, repository };
	}

	test("renders full canonical history with attachment references and coherent tool interactions", async () => {
		const { repository } = await setup();
		const attachments = new AttachmentService(repository);
		await attachments.create(USER_A, { id: "image", storageKey: "uploads/image", filename: "photo.png", mimeType: "image/png", kind: "image", byteSize: 8, sha256: "sha" });
		await attachments.bind(USER_A, CONVERSATION_ID, "user-message", "image", 0);
		const byMessage = new Map<string, AttachmentRecord[]>();
		for (const binding of await repository.listMessageAttachments(USER_A, CONVERSATION_ID))
			byMessage.set(binding.messageId, [...(byMessage.get(binding.messageId) ?? []), binding.attachment]);
		const turns = projectVisibleTurns(await repository.listCanonicalMessages(USER_A, CONVERSATION_ID), byMessage);
		expect(turns.map((turn) => turn.displayText)).toEqual(["What is the weather?", "20 C and clear\nIt is 20 C and clear in Austin."]);
		expect(turns[0]?.attachments).toEqual([{ id: "image", filename: "photo.png", mimeType: "image/png", kind: "image", byteSize: 8, storageKey: "uploads/image" }]);
		expect(turns[1]?.messages.map((message) => message.role)).toEqual(["assistant", "toolResult", "assistant"]);
	});

	test("records unsupported and budget attachment context decisions without changing canonical messages", async () => {
		const { repository } = await setup();
		const attachments = new AttachmentService(repository);
		await attachments.create(USER_A, { id: "image", storageKey: "uploads/image", filename: "photo.png", mimeType: "image/png", kind: "image", byteSize: 8, sha256: "sha" });
		await attachments.bind(USER_A, CONVERSATION_ID, "user-message", "image", 0);
		const records = await repository.listCanonicalMessages(USER_A, CONVERSATION_ID);
		const byMessage = new Map([["user-message", [await repository.getAttachment(USER_A, "image")]]]);
		const unsupported = materializeContext(CONVERSATION_ID, records, [], { attachmentsByMessageId: byMessage, capabilities: { supportsImages: false }, resolve: () => ({ type: "image", data: "encoded" }) });
		expect(unsupported.manifest.attachmentDecisions).toEqual([{ messageId: "user-message", attachmentId: "image", decision: "unsupported_by_model" }]);
		expect(unsupported.context[0]).toEqual(records[0]?.message);
		const overBudget = materializeContext(CONVERSATION_ID, records, [], { attachmentsByMessageId: byMessage, capabilities: { supportsImages: true, maxAttachmentBytes: 4 }, resolve: () => ({ type: "image", data: "encoded" }) });
		expect(overBudget.manifest.attachmentDecisions).toEqual([{ messageId: "user-message", attachmentId: "image", decision: "omitted_by_budget" }]);
		const unavailable = materializeContext(CONVERSATION_ID, records, [], { attachmentsByMessageId: byMessage, capabilities: { supportsImages: true }, resolve: () => null });
		expect(unavailable.manifest.attachmentDecisions).toEqual([{ messageId: "user-message", attachmentId: "image", decision: "unavailable" }]);
		const included = materializeContext(CONVERSATION_ID, records, [], { attachmentsByMessageId: byMessage, capabilities: { supportsImages: true }, resolve: () => ({ type: "image", data: "encoded" }) });
		expect(included.manifest.attachmentDecisions).toEqual([{ messageId: "user-message", attachmentId: "image", decision: "included" }]);
		expect(included.context[0]).toMatchObject({ role: "user", content: [{ type: "text", text: "What is the weather?" }, { type: "image", data: "encoded", mimeType: "image/png" }] });
	});

	test("rebuilds identical search entries from canonical messages", async () => {
		const { repository } = await setup();
		const records = await repository.listCanonicalMessages(USER_A, CONVERSATION_ID);
		const initial = rebuildSearchProjection(records);
		expect(rebuildSearchProjection(records)).toEqual(initial);
		expect(searchProjection(initial, "austin").map((entry) => entry.messageId)).toEqual(["assistant-message-2"]);
	});

	test("organizes conversations without modifying canonical JSON and rejects cross-user ownership", async () => {
		const { database, repository } = await setup();
		const originalMessages = await repository.listCanonicalMessages(USER_A, CONVERSATION_ID);
		await repository.createConversation(USER_B, { id: "other-conversation", title: "Other" });
		await repository.createFolder(USER_A, { id: "folder-a", name: "Work" });
		await repository.createFolder(USER_B, { id: "folder-b", name: "Private" });
		await repository.createTag(USER_A, { id: "tag-a", name: "urgent" });
		await repository.createTag(USER_B, { id: "tag-b", name: "private" });
		await repository.renameConversation(USER_A, CONVERSATION_ID, "Renamed");
		await repository.setConversationFolder(USER_A, CONVERSATION_ID, "folder-a");
		await repository.setConversationTags(USER_A, CONVERSATION_ID, ["tag-a"]);
		expect(await repository.listConversations(USER_A)).toMatchObject([{ id: CONVERSATION_ID, title: "Renamed", folderId: "folder-a", tagIds: ["tag-a"] }]);
		expect(await repository.listCanonicalMessages(USER_A, CONVERSATION_ID)).toEqual(originalMessages);
		await expect(repository.setConversationFolder(USER_A, CONVERSATION_ID, "folder-b")).rejects.toBeInstanceOf(V2NotFoundError);
		await expect(repository.setConversationTags(USER_A, CONVERSATION_ID, ["tag-b"])).rejects.toBeInstanceOf(V2NotFoundError);
		await expect(repository.bindAttachment(USER_B, CONVERSATION_ID, "user-message", "image", 0)).rejects.toBeInstanceOf(V2NotFoundError);
		await repository.deleteConversation(USER_A, CONVERSATION_ID);
		expect(await database.db.selectFrom("v2_conversation_tag").selectAll().execute()).toEqual([]);
	});
});
