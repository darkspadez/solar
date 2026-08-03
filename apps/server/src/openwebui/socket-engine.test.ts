import { describe, expect, test } from "bun:test";
import { Server as Engine } from "@socket.io/bun-engine";
import { Server as SocketIOServer } from "socket.io";
import { io as socketClient } from "socket.io-client";

describe("Open WebUI Socket.IO transport", () => {
	test("serves the Open WebUI path through Bun's native engine", async () => {
		const io = new SocketIOServer();
		const engine = new Engine({ path: "/ws/socket.io/" });
		io.bind(engine);
		const joined = new Promise<void>((resolve, reject) => {
			io.on("connection", (socket) => {
				expect(socket.handshake.auth).toEqual({ token: "test-token" });
				socket.on("user-join", (_payload, acknowledge) => {
					acknowledge({ id: "test-user", name: "Test User" });
					resolve();
				});
			});
			io.on("connection_error", (error) => reject(new Error(error.message)));
		});
		const engineHandler = engine.handler();
		const server = Bun.serve({
			port: 0,
			websocket: engineHandler.websocket,
			idleTimeout: engineHandler.idleTimeout,
			fetch(request, bunServer) {
				const pathname = new URL(request.url).pathname;
				return pathname === "/ws/socket.io/" || pathname === "/ws/socket.io"
					? engine.handleRequest(request, bunServer)
					: new Response("Not found", { status: 404 });
			},
		});
		const client = socketClient(server.url.toString(), {
			path: "/ws/socket.io/",
			transports: ["websocket"],
			auth: { token: "test-token" },
			reconnection: false,
		});
		try {
			await new Promise<void>((resolve, reject) => {
				const timeout = setTimeout(
					() => reject(new Error("Socket.IO test connection timed out")),
					5_000,
				);
				client.once("connect_error", reject);
				client.once("connect", () => {
					client.emit(
						"user-join",
						{ auth: { token: "test-token" } },
						(user: { id: string; name: string }) => {
							clearTimeout(timeout);
							expect(user).toEqual({ id: "test-user", name: "Test User" });
							resolve();
						},
					);
				});
			});
			await joined;
		} finally {
			client.close();
			io.close();
			engine.close();
			server.stop();
		}
	});
});
