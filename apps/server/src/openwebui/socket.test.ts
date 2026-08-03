import { afterAll, describe, expect, mock, test } from "bun:test";
import { Server as Engine } from "@socket.io/bun-engine";
import { Server as SocketIOServer } from "socket.io";
import { io as socketClient } from "socket.io-client";

const subscribers = new Map<string, { chunk: Function; end: Function }>();

mock.module("./auth", () => ({
	resolveOpenWebUiPrincipal: async () => ({
		id: "socket-user",
		name: "Socket User",
		email: "socket@example.test",
		role: "user",
		isAdmin: false,
	}),
}));
mock.module("../chat/generationManager", () => ({
	generationManager: {
		subscribeChunks: (
			messageId: string,
			_lastEventId: number,
			subscriber: { chunk: Function; end: Function },
		) => {
			subscribers.set(messageId, subscriber);
			return () => subscribers.delete(messageId);
		},
		replayChunks: () => true,
	},
}));
mock.module("../chat/v2Live", () => ({ stopGeneration: async () => true }));

const { OpenWebUiSocketGateway } = await import("./socket");

describe("Open WebUI Socket.IO gateway", () => {
	test("broadcasts generation chunks and clears completed tasks", async () => {
		const gateway = new OpenWebUiSocketGateway();
		const io = new SocketIOServer();
		const engine = new Engine({ path: "/ws/socket.io/" });
		io.bind(engine);
		gateway.bind(io);
		const handler = engine.handler();
		const server = Bun.serve({
			port: 0,
			websocket: handler.websocket,
			idleTimeout: handler.idleTimeout,
			fetch(request, bunServer) {
				return engine.handleRequest(request, bunServer);
			},
		});
		const client = socketClient(server.url.toString(), {
			path: "/ws/socket.io/",
			transports: ["websocket"],
			auth: { token: "socket-token" },
			reconnection: false,
		});
		try {
			await new Promise<void>((resolve, reject) => {
				const timeout = setTimeout(
					() => reject(new Error("socket timeout")),
					5_000,
				);
				client.once("connect_error", reject);
				client.once("connect", () =>
					client.emit("user-join", { auth: { token: "socket-token" } }, () => {
						clearTimeout(timeout);
						resolve();
					}),
				);
			});
			const events: Record<string, unknown>[] = [];
			const completed = new Promise<void>((resolve) => {
				client.on("events", (event: Record<string, unknown>) => {
					events.push(event);
					const data = event.data as Record<string, unknown> | undefined;
					const payload = data?.data as Record<string, unknown> | undefined;
					if (payload?.done === true) resolve();
				});
			});
			gateway.attachTask({
				userId: "socket-user",
				chatId: "chat-1",
				messageId: "message-1",
				socketId: client.id,
			});
			subscribers.get("message-1")!.chunk({
				id: 1,
				chunk: { type: "start", messageId: "message-1" },
			});
			subscribers.get("message-1")!.chunk({
				id: 2,
				chunk: { type: "text-delta", textDelta: "Hello" },
			});
			subscribers.get("message-1")!.chunk({
				id: 3,
				chunk: {
					type: "finish",
					finishReason: "stop",
					usage: { inputTokens: 3, outputTokens: 5 },
				},
			});
			await completed;
			expect(events).toEqual([
				{
					chat_id: "chat-1",
					message_id: "message-1",
					data: {
						type: "chat:completion",
						data: { done: false, choices: [{ delta: {} }] },
					},
				},
				{
					chat_id: "chat-1",
					message_id: "message-1",
					data: {
						type: "chat:completion",
						data: { done: false, choices: [{ delta: { content: "Hello" } }] },
					},
				},
				{
					chat_id: "chat-1",
					message_id: "message-1",
					data: {
						type: "chat:completion",
						data: {
							done: true,
							choices: [{ delta: {} }],
							finish_reason: "stop",
							usage: {
								prompt_tokens: 3,
								completion_tokens: 5,
								total_tokens: 8,
							},
						},
					},
				},
			]);
			expect(gateway.taskIds("socket-user", "chat-1")).toEqual(["message-1"]);
			subscribers.get("message-1")!.end();
			expect(gateway.taskIds("socket-user", "chat-1")).toEqual([]);
		} finally {
			gateway.close();
			client.close();
			io.close();
			engine.close();
			server.stop();
		}
	});

	afterAll(() => subscribers.clear());
});
