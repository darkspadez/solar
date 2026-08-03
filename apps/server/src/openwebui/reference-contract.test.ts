import { describe, expect, test } from "bun:test";
import { io } from "socket.io-client";

const referenceUrl = process.env.OPENWEBUI_REFERENCE_URL?.replace(/\/$/, "");
const referenceToken = process.env.OPENWEBUI_REFERENCE_TOKEN;
const referenceCookie = process.env.OPENWEBUI_REFERENCE_COOKIE;
const referenceConfigured = Boolean(referenceUrl && referenceToken);
const mutationsEnabled =
	referenceConfigured && process.env.OPENWEBUI_REFERENCE_MUTATIONS === "1";
const referenceTest = referenceConfigured ? test : test.skip;
const mutationTest = mutationsEnabled ? test : test.skip;

interface JsonResponse<T = unknown> {
	status: number;
	body: T;
}

function headers(): HeadersInit {
	return {
		accept: "application/json",
		authorization: `Bearer ${referenceToken}`,
		...(referenceCookie ? { cookie: referenceCookie } : {}),
	};
}

async function request<T = unknown>(
	path: string,
	init: RequestInit = {},
): Promise<JsonResponse<T>> {
	if (!referenceUrl)
		throw new Error("OPENWEBUI_REFERENCE_URL is not configured");
	const response = await fetch(new URL(path, referenceUrl), {
		...init,
		headers: { ...headers(), ...init.headers },
	});
	const text = await response.text();
	let body: T;
	try {
		body = JSON.parse(text) as T;
	} catch {
		body = text as T;
	}
	return { status: response.status, body };
}

async function listChatIds(): Promise<string[]> {
	const response = await request<unknown[]>("/api/v1/chats/?page=1");
	expect(response.status).toBe(200);
	expect(Array.isArray(response.body)).toBe(true);
	return response.body.flatMap((chat) =>
		chat &&
		typeof chat === "object" &&
		typeof (chat as Record<string, unknown>).id === "string"
			? [(chat as Record<string, unknown>).id as string]
			: [],
	);
}

describe("Open WebUI reference contract", () => {
	referenceTest("OWUI-REST-002 lists user-scoped chats", async () => {
		const response = await request<unknown[]>("/api/v1/chats/?page=1");
		expect(response.status).toBe(200);
		expect(Array.isArray(response.body)).toBe(true);
		for (const chat of response.body) {
			expect(chat).toMatchObject({
				id: expect.any(String),
				title: expect.any(String),
				created_at: expect.any(Number),
				updated_at: expect.any(Number),
			});
		}
	});

	referenceTest(
		"OWUI-REST-003 opens a chat with a valid history tree",
		async () => {
			const [chatId] = await listChatIds();
			if (!chatId) return;
			const response = await request<Record<string, unknown>>(
				`/api/v1/chats/${encodeURIComponent(chatId)}`,
			);
			expect(response.status).toBe(200);
			expect(response.body).toMatchObject({
				id: chatId,
				user_id: expect.any(String),
				chat: expect.any(Object),
			});
			const chat = response.body.chat as Record<string, unknown>;
			const history = chat.history as Record<string, unknown>;
			if (!history || typeof history.messages !== "object") return;
			const messages = history.messages as Record<
				string,
				Record<string, unknown>
			>;
			expect(typeof history.currentId).toBe("string");
			expect(messages).toBeDefined();
			expect(messages[history.currentId as string]).toBeDefined();
			for (const [id, message] of Object.entries(messages)) {
				expect(message).toMatchObject({
					id,
					role: expect.any(String),
					content: expect.anything(),
				});
				const children = message.childrenIds as unknown[];
				expect(Array.isArray(children)).toBe(true);
				for (const childId of children) {
					expect(messages[childId as string]).toBeDefined();
					expect(messages[childId as string]?.parentId).toBe(id);
				}
			}
		},
	);

	referenceTest("OWUI-REST-004 reports chat task state", async () => {
		const [chatId] = await listChatIds();
		if (!chatId) return;
		const response = await request<{ task_ids: unknown }>(
			`/api/tasks/chat/${encodeURIComponent(chatId)}`,
		);
		expect(response.status).toBe(200);
		expect(Array.isArray(response.body.task_ids)).toBe(true);
	});

	referenceTest("OWUI-REST-006 serves supporting chat state", async () => {
		const [chatId] = await listChatIds();
		const paths = [
			"/api/v1/chats/pinned",
			"/api/v1/chats/all/tags",
			"/api/v1/folders/",
			"/api/v1/folders/shared",
		];
		if (chatId)
			paths.push(`/api/v1/chats/${encodeURIComponent(chatId)}/pinned`);
		for (const path of paths) {
			const response = await request(path);
			expect(response.status).toBe(200);
			expect(
				Array.isArray(response.body) || typeof response.body === "boolean",
			).toBe(true);
		}
	});

	referenceTest("OWUI-TOOL-001 exposes the user tool catalog", async () => {
		const response = await request<unknown[]>("/api/v1/tools/");
		expect(response.status).toBe(200);
		expect(Array.isArray(response.body)).toBe(true);
	});

	referenceTest(
		"OWUI-SOCK-001 accepts Socket.IO auth and user-join",
		async () => {
			if (!referenceUrl || !referenceToken)
				throw new Error("reference environment is not configured");
			await new Promise<void>((resolve, reject) => {
				const socket = io(referenceUrl, {
					path: "/ws/socket.io/",
					transports: ["websocket"],
					auth: { token: referenceToken },
					reconnection: false,
				});
				const timeout = setTimeout(() => {
					socket.close();
					reject(new Error("Socket.IO reference connection timed out"));
				}, 15_000);
				const finish = (error?: Error) => {
					clearTimeout(timeout);
					socket.close();
					if (error) reject(error);
					else resolve();
				};
				socket.once("connect_error", (error) => finish(error));
				socket.once("connect", () => {
					socket.emit(
						"user-join",
						{ auth: { token: referenceToken } },
						(user: unknown) => {
							expect(user).toMatchObject({
								id: expect.any(String),
								name: expect.any(String),
							});
							socket.emit("heartbeat", {});
							finish();
						},
					);
				});
			});
		},
	);

	mutationTest(
		"OWUI-FOLDER-001 supports folder create, rename, and delete",
		async () => {
			const created = await request<{ id: string }>("/api/v1/folders/", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					name: "Solar contract test",
					data: {},
					meta: {},
					parent_id: null,
				}),
			});
			expect(created.status).toBe(200);
			expect(created.body.id).toEqual(expect.any(String));
			try {
				const folderId = created.body.id;
				const renamed = await request(`/api/v1/folders/${folderId}/update`, {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({
						name: "Solar contract test renamed",
						data: {},
						meta: {},
					}),
				});
				expect(renamed.status).toBe(200);
			} finally {
				const deleted = await request(
					`/api/v1/folders/${created.body.id}?delete_contents=false`,
					{ method: "DELETE" },
				);
				expect(deleted.status).toBe(200);
				expect(deleted.body).toBe(true);
			}
		},
	);

	mutationTest("OWUI-STOP-001 exposes chat task cancellation", async () => {
		const [chatId] = await listChatIds();
		if (!chatId) return;
		const response = await request<{ status: boolean }>(
			`/api/tasks/chat/${encodeURIComponent(chatId)}/stop`,
			{ method: "POST" },
		);
		expect(response.status).toBe(200);
		expect(response.body.status).toBe(true);
	});
});
