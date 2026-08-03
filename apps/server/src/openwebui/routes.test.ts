import { beforeAll, afterAll, describe, expect, mock, test } from "bun:test";
import { createV2TestDatabase } from "../chat-v2/db/fixtures";
import { ChatV2Repository } from "../chat-v2/db/repository";

const USER_ID = "openwebui-user";
const database = await createV2TestDatabase();
const repository = new ChatV2Repository(database.db);
const completionCalls: Array<Record<string, unknown>> = [];

mock.module("../db", () => ({ db: database.db, sqlite: database.sqlite }));
mock.module("../auth", () => ({
	getSolarSession: async () => null,
	auth: {
		api: {
			verifyApiKey: async () => ({
				valid: true,
				key: { referenceId: USER_ID },
			}),
			signInEmail: async () => ({ user: { id: USER_ID } }),
		},
	},
	createSolarApiKey: async () => ({ id: "key", key: "sk_solar_test" }),
}));
mock.module("../chat/catalog", () => ({
	listAvailableModels: async () => [
		{
			provider: "mock",
			endpointId: "mock",
			modelId: "mock-model",
			api: "mock",
			name: "Mock Model",
			reasoning: false,
			vision: false,
			documents: false,
		},
	],
	resolveSelection: async () => ({
		provider: "mock",
		endpointId: "mock",
		modelId: "mock-model",
		api: "mock",
	}),
}));
mock.module("../chat/generationManager", () => ({
	generationManager: {
		subscribeChunks: () => () => {},
		replayChunks: () => true,
		isActive: () => false,
		stop: () => true,
	},
}));
mock.module("../chat/v2Live", () => ({
	chatV2Repository: repository,
	loadMessages: async () => [],
	sendMessage: async (input: Record<string, unknown>) => {
		completionCalls.push(input);
		return "assistant-message";
	},
	stopGeneration: async () => true,
}));

const { createOpenWebUiRoutes } = await import("./routes");

const authHeaders = { authorization: "Bearer sk_solar_test" };

async function request(path: string, init: RequestInit = {}) {
	return createOpenWebUiRoutes({
		attachTask: (input: Record<string, unknown>) => completionCalls.push(input),
		taskIds: () => [],
		stopTasks: async () => false,
		stopTask: async () => false,
		close: () => {},
	} as never).request(`http://solar.local${path}`, {
		...init,
		headers: { ...authHeaders, ...init.headers },
	});
}

beforeAll(() => {
	database.sqlite.exec(
		"alter table user add column name text; alter table user add column email text; alter table user add column role text; alter table user add column isDisabled integer;",
	);
	database.seedUser(USER_ID);
	database.sqlite
		.query(
			"update user set name = ?, email = ?, role = ?, isDisabled = 0 where id = ?",
		)
		.run("Open WebUI User", "openwebui@example.test", "user", USER_ID);
});
afterAll(async () => database.destroy());

describe("Open WebUI REST facade", () => {
	test("lists and mutates Solar folders with ownership enforcement", async () => {
		const created = await request("/api/v1/folders/", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ name: "Work" }),
		});
		expect(created.status).toBe(200);
		const folder = (await created.json()) as { id: string };

		const listed = await request("/api/v1/folders/");
		expect(await listed.json()).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ id: folder.id, name: "Work" }),
			]),
		);

		const renamed = await request(`/api/v1/folders/${folder.id}/update`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ name: "Renamed" }),
		});
		expect(renamed.status).toBe(200);
		expect((await renamed.json()).name).toBe("Renamed");

		const deleted = await request(`/api/v1/folders/${folder.id}`, {
			method: "DELETE",
		});
		expect(deleted.status).toBe(200);
		expect(await deleted.json()).toBe(true);
	});

	test("creates, lists, opens, folders, and deletes chats", async () => {
		const conversation = await repository.createConversation(USER_ID, {
			id: "openwebui-chat",
			title: "Compatibility chat",
		});
		const list = await request("/api/v1/chats/?page=1");
		expect(list.status).toBe(200);
		expect(await list.json()).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					id: conversation.id,
					title: "Compatibility chat",
				}),
			]),
		);

		const opened = await request(`/api/v1/chats/${conversation.id}`);
		expect(opened.status).toBe(200);
		expect((await opened.json()).chat.history.currentId).toBeNull();

		const folder = await repository.createFolder(USER_ID, {
			name: "Chat folder",
		});
		const moved = await request(`/api/v1/chats/${conversation.id}/folder`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ folder_id: folder.id }),
		});
		expect(moved.status).toBe(200);
		expect((await moved.json()).folder_id).toBe(folder.id);

		const deleted = await request(`/api/v1/chats/${conversation.id}`, {
			method: "DELETE",
		});
		expect(deleted.status).toBe(200);
		expect(await deleted.json()).toBe(true);
	});

	test("accepts Open WebUI completion requests and returns a task", async () => {
		completionCalls.splice(0);
		const response = await request("/api/chat/completions", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				stream: true,
				model: "mock-model",
				tool_servers: [],
				user_message: { role: "user", content: "Hello" },
			}),
		});
		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({
			status: true,
			task_ids: ["assistant-message"],
			chat_id: expect.any(String),
		});
		expect(completionCalls[0]).toMatchObject({
			userId: USER_ID,
			text: "Hello",
		});
	});

	test("acknowledges Conduit's legacy task completion payload", async () => {
		completionCalls.splice(0);
		const conversation = await repository.createConversation(USER_ID, {
			id: "conduit-server-chat",
			title: "Conduit chat",
		});
		const response = await request("/api/chat/completions", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				stream: true,
				model: "mock-model",
				tool_servers: [],
				chat_id: conversation.id,
				session_id: "conduit-socket-session",
				parent_id: null,
				parent_message: {
					id: "legacy-user-message",
					role: "user",
					content: "Legacy hello",
				},
			}),
		});
		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({
			status: true,
			task_ids: ["assistant-message"],
			chat_id: conversation.id,
		});
		expect(completionCalls[0]).toMatchObject({
			userId: USER_ID,
			conversationId: conversation.id,
			text: "Legacy hello",
		});
		expect(completionCalls[1]).toEqual({
			userId: USER_ID,
			chatId: conversation.id,
			messageId: "assistant-message",
			socketId: "conduit-socket-session",
		});
	});

	test("reports unknown client-created chats as idle tasks", async () => {
		const response = await request("/api/tasks/chat/client-created-chat");
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ task_ids: [] });
	});
});
