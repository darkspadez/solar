import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import { createV2TestDatabase } from "./db/fixtures";
import { ChatV2Repository } from "./db/repository";
import { AttachmentService } from "./attachments";

const USER_ID = "live-user";
const IMPORT_USER_ID = "live-import-user";
const database = await createV2TestDatabase();

process.env.SOLAR_ATTACHMENTS_DIR = "/test/attachments";

mock.module("../db", () => ({ db: database.db, sqlite: database.sqlite }));
mock.module("../auth", () => ({
	getSolarSession: async () => ({ user: { id: USER_ID, role: "user" } }),
	createSolarApiKey: async () => ({ id: "key", key: "key" }),
	createSolarUser: async () => {},
	setSolarUserPassword: async () => true,
}));
mock.module("@struktoai/mirage-node", () => ({
	DiskResource: class {
		open = async () => {};
		mkdir = async () => {};
		writeFile = async () => {};
	},
	PathSpec: { fromStrPath: (value: string) => ({ toString: () => value }) },
}));

const { attachmentRoutes } = await import("../chat/attachmentRoutes");
const { appRouter } = await import("../trpc/router");

function v1Count(table: "conversation" | "message" | "attachment") {
	return (database.sqlite.query(`select count(*) as count from ${table}`).get() as { count: number }).count;
}

beforeAll(() => {
	database.seedUser(USER_ID);
	database.seedUser(IMPORT_USER_ID);
	database.sqlite.exec(`
		create table conversation (id text primary key, userId text not null, title text not null);
		create table message (id text primary key, conversationId text not null, text text not null);
		create table attachment (id text primary key, userId text not null, messageId text);
	`);
});

afterAll(async () => {
	await database.destroy();
});

describe("chat-v2 live routes", () => {
	test("uploads and binds attachments only in v2 tables", async () => {
		const form = new FormData();
		form.set("file", new File(["route attachment"], "note.txt", { type: "text/plain" }));
		const response = await attachmentRoutes.request("http://localhost/", {
			method: "POST",
			body: form,
		});
		expect(response.status).toBe(200);
		const uploaded = await response.json() as { id: string };

		const repository = new ChatV2Repository(database.db);
		await repository.createConversation(USER_ID, { id: "attachment-conversation", title: "Attachment" });
		await repository.createTurn(USER_ID, "attachment-conversation", {
			id: "attachment-turn", ordinal: 0, role: "user", origin: "text", status: "complete",
		});
		await repository.appendCanonicalMessages(USER_ID, "attachment-conversation", [{
			id: "attachment-message",
			turnId: "attachment-turn",
			message: { role: "user", content: "See file", timestamp: 1 },
			origin: "text",
			status: "complete",
		}]);
		await new AttachmentService(repository).bind(
			USER_ID,
			"attachment-conversation",
			"attachment-message",
			uploaded.id,
			0,
		);

		expect(await repository.listMessageAttachments(USER_ID, "attachment-conversation")).toHaveLength(1);
		expect(v1Count("attachment")).toBe(0);
	});

	test("lists, renames, and deletes only v2 conversations", async () => {
		const repository = new ChatV2Repository(database.db);
		await repository.createConversation(USER_ID, { id: "managed-conversation", title: "Before" });
		const caller = appRouter.createCaller({ user: { id: USER_ID, role: "user" } } as never);

		expect((await caller.conversation.list()).map((conversation) => conversation.id)).toContain("managed-conversation");
		await caller.conversation.rename({ id: "managed-conversation", title: "After" });
		expect((await repository.getConversation(USER_ID, "managed-conversation")).title).toBe("After");
		await caller.conversation.remove({ id: "managed-conversation" });
		await expect(repository.getConversation(USER_ID, "managed-conversation")).rejects.toThrow();
		expect(v1Count("conversation")).toBe(0);
	});

	test("searches the v2 canonical-message projection without v1 rows", async () => {
		const repository = new ChatV2Repository(database.db);
		await repository.createConversation(USER_ID, { id: "search-conversation", title: "Unrelated" });
		await repository.appendCanonicalMessages(USER_ID, "search-conversation", [{
			id: "search-message",
			message: { role: "user", content: "Needle from canonical history", timestamp: 1 },
			origin: "text",
			status: "complete",
		}]);

		const caller = appRouter.createCaller({ user: { id: USER_ID, role: "user" } } as never);
		expect(await caller.conversation.search({ query: "needle" })).toEqual([
			{ id: "search-conversation", title: "Unrelated", updatedAt: expect.any(String) },
		]);
		expect(v1Count("conversation")).toBe(0);
		expect(v1Count("message")).toBe(0);
	});

	test("exports and imports v2 history through v2 tables with remapped IDs", async () => {
		const repository = new ChatV2Repository(database.db);
		await repository.createConversation(USER_ID, {
			id: "history-conversation",
			title: "Portable V2 history",
		});
		await repository.createTurn(USER_ID, "history-conversation", {
			id: "history-turn",
			ordinal: 0,
			role: "user",
			origin: "text",
			status: "complete",
		});
		await repository.appendCanonicalMessages(USER_ID, "history-conversation", [{
			id: "history-message",
			turnId: "history-turn",
			message: { role: "user", content: "Export me", timestamp: 1 },
			origin: "text",
			status: "complete",
		}]);

		const caller = appRouter.createCaller({ user: { id: USER_ID, role: "admin" } } as never);
		const history = await caller.admin.history.export({
			userId: USER_ID,
			conversationId: "history-conversation",
		});
		if (!("version" in history)) throw new Error("expected a single-conversation export bundle");
		expect(history.version).toBe(2);
		const imported = await caller.admin.history.import({
			userId: IMPORT_USER_ID,
			history,
			remap: true,
		});
		if (!imported || !("conversationId" in imported)) throw new Error("expected v2 import result");
		expect(
			(await repository.listCanonicalMessages(IMPORT_USER_ID, imported.conversationId)).map(
				(message) => message.message,
			),
		).toEqual([{ role: "user", content: "Export me", timestamp: 1 }]);
		expect(v1Count("conversation")).toBe(0);
		expect(v1Count("message")).toBe(0);
	});
});
