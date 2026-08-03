import { Server, type Socket } from "socket.io";
import {
	generationManager,
	type BufferedChunk,
	type GenerationChunkSubscriber,
} from "../chat/generationManager";
import { stopGeneration } from "../chat/v2Live";
import { getLogLevel, logger } from "../logger";
import { resolveOpenWebUiPrincipal, type OpenWebUiPrincipal } from "./auth";
import { completionData } from "./events";

const TASK_RETENTION_MS = 60_000;

function traceSocket(event: string, metadata: Record<string, unknown>) {
	const entry = logger.withMetadata({
		component: "openwebui",
		transport: "socket.io",
		...metadata,
	});
	if (getLogLevel() === "trace") entry.trace(event);
	else entry.info(`trace: ${event}`);
}

function chunkMetadata(chunk: BufferedChunk["chunk"]) {
	switch (chunk.type) {
		case "text-delta":
			return { type: chunk.type, textLength: chunk.textDelta.length };
		case "reasoning-delta":
			return { type: chunk.type, reasoningLength: chunk.delta.length };
		case "tool-call-start":
			return {
				type: chunk.type,
				toolCallId: chunk.toolCallId,
				toolName: chunk.toolName,
			};
		case "tool-call-delta":
			return {
				type: chunk.type,
				toolCallId: chunk.toolCallId,
				argumentsLength: chunk.argsText.length,
			};
		case "tool-call-end":
			return { type: chunk.type, toolCallId: chunk.toolCallId };
		case "tool-call-result":
			return {
				type: chunk.type,
				toolCallId: chunk.toolCallId,
				outputLength: chunk.output.length,
				isError: chunk.isError,
			};
		case "finish":
			return {
				type: chunk.type,
				finishReason: chunk.finishReason,
				usage: chunk.usage,
			};
		case "title-update":
			return { type: chunk.type, titleLength: chunk.title.length };
		case "error":
			return { type: chunk.type, errorLength: chunk.errorText.length };
		case "start":
			return { type: chunk.type, messageId: chunk.messageId };
	}
}

interface OpenWebUiTask {
	messageId: string;
	chatId: string;
	userId: string;
	done: boolean;
	socketIds: Set<string>;
	unsubscribe: (() => void) | null;
	cleanupTimer: ReturnType<typeof setTimeout> | null;
}

function userRoom(userId: string): string {
	return `openwebui:user:${userId}`;
}

function eventEnvelope(task: OpenWebUiTask, data: Record<string, unknown>) {
	return {
		chat_id: task.chatId,
		message_id: task.messageId,
		data: { type: "chat:completion", data },
	};
}

export class OpenWebUiSocketGateway {
	private io: Server | null = null;
	private readonly tasks = new Map<string, OpenWebUiTask>();
	private readonly socketUsers = new Map<string, OpenWebUiPrincipal>();

	bind(io: Server): void {
		this.io = io;
		io.on("connection", (socket) => this.handleConnection(socket));
	}

	private handleConnection(socket: Socket): void {
		const handshakeToken = socket.handshake.auth?.token;
		const token = typeof handshakeToken === "string" ? handshakeToken : null;
		traceSocket("socket connection received", {
			socketId: socket.id,
			hasHandshakeToken: Boolean(token),
		});
		const authenticate = async (candidate: string | null) => {
			if (!candidate) return null;
			const headers = new Headers({ authorization: `Bearer ${candidate}` });
			return resolveOpenWebUiPrincipal(headers);
		};
		const activate = (user: OpenWebUiPrincipal) => {
			this.socketUsers.set(socket.id, user);
			socket.data.openWebUiUser = user;
			void socket.join(userRoom(user.id));
			for (const task of this.tasks.values()) {
				if (task.userId === user.id && !task.done)
					this.attachSocket(task, socket);
			}
			traceSocket("socket authenticated", {
				socketId: socket.id,
				userId: user.id,
				activeTaskCount: [...this.tasks.values()].filter(
					(task) => task.userId === user.id && !task.done,
				).length,
			});
		};

		void authenticate(token).then((user) => {
			if (user) activate(user);
			else
				traceSocket("socket handshake authentication failed", {
					socketId: socket.id,
				});
		});
		socket.on(
			"user-join",
			(
				payload: { auth?: { token?: unknown } } | undefined,
				acknowledge?: (user: { id: string; name: string }) => void,
			) => {
				const nestedToken = payload?.auth?.token;
				const candidate = typeof nestedToken === "string" ? nestedToken : token;
				void authenticate(candidate).then((user) => {
					if (!user) {
						traceSocket("socket user-join rejected", {
							socketId: socket.id,
							hasToken: Boolean(candidate),
						});
						socket.disconnect(true);
						return;
					}
					activate(user);
					traceSocket("socket user-join acknowledged", {
						socketId: socket.id,
						userId: user.id,
					});
					acknowledge?.({ id: user.id, name: user.name });
				});
			},
		);
		socket.on("heartbeat", () => {});
		socket.on("disconnect", () => {
			traceSocket("socket disconnected", {
				socketId: socket.id,
				userId: this.socketUsers.get(socket.id)?.id,
			});
			this.socketUsers.delete(socket.id);
			for (const task of this.tasks.values()) task.socketIds.delete(socket.id);
		});
	}

	attachTask(input: {
		userId: string;
		chatId: string;
		messageId: string;
		socketId?: string;
	}): void {
		const existing = this.tasks.get(input.messageId);
		if (existing) {
			if (existing.userId !== input.userId || existing.chatId !== input.chatId)
				throw new Error("Open WebUI task ownership conflict");
			if (input.socketId) {
				const socket = this.socketForUser(input.socketId, input.userId);
				if (socket) this.attachSocket(existing, socket);
			}
			return;
		}
		traceSocket("socket task attached", {
			userId: input.userId,
			chatId: input.chatId,
			messageId: input.messageId,
			socketId: input.socketId,
		});
		const task: OpenWebUiTask = {
			messageId: input.messageId,
			chatId: input.chatId,
			userId: input.userId,
			done: false,
			socketIds: new Set(),
			unsubscribe: null,
			cleanupTimer: null,
		};
		const subscriber: GenerationChunkSubscriber = {
			chunk: (bufferedChunk) => this.broadcastChunk(task, bufferedChunk),
			end: () => {
				task.done = true;
				traceSocket("socket task stream ended", {
					userId: task.userId,
					chatId: task.chatId,
					messageId: task.messageId,
				});
				task.cleanupTimer = setTimeout(
					() => this.removeTask(task.messageId),
					TASK_RETENTION_MS,
				);
			},
		};
		this.tasks.set(task.messageId, task);
		task.unsubscribe = generationManager.subscribeChunks(
			input.messageId,
			0,
			subscriber,
		);
		if (input.socketId) {
			const socket = this.socketForUser(input.socketId, input.userId);
			if (socket) this.attachSocket(task, socket, false);
		}
	}

	private socketForUser(socketId: string, userId: string): Socket | undefined {
		const socket = this.io?.sockets.sockets.get(socketId);
		return this.socketUsers.get(socketId)?.id === userId ? socket : undefined;
	}

	private attachSocket(
		task: OpenWebUiTask,
		socket: Socket,
		replay = true,
	): void {
		if (task.socketIds.has(socket.id)) return;
		task.socketIds.add(socket.id);
		traceSocket("socket task subscription attached", {
			userId: task.userId,
			chatId: task.chatId,
			messageId: task.messageId,
			socketId: socket.id,
			replay,
		});
		if (!replay) return;
		generationManager.replayChunks(task.messageId, 0, (bufferedChunk) =>
			socket.emit(
				"events",
				eventEnvelope(task, completionData(bufferedChunk.chunk)),
			),
		);
	}

	private broadcastChunk(
		task: OpenWebUiTask,
		bufferedChunk: BufferedChunk,
	): void {
		this.io
			?.to(userRoom(task.userId))
			.emit("events", eventEnvelope(task, completionData(bufferedChunk.chunk)));
		traceSocket("socket completion event emitted", {
			userId: task.userId,
			chatId: task.chatId,
			messageId: task.messageId,
			sequence: bufferedChunk.id,
			chunk: chunkMetadata(bufferedChunk.chunk),
		});
	}

	taskIds(userId: string, chatId: string): string[] {
		return [...this.tasks.values()]
			.filter(
				(task) =>
					task.userId === userId && task.chatId === chatId && !task.done,
			)
			.map((task) => task.messageId);
	}

	async stopTasks(
		userId: string,
		chatId: string,
		messageId?: string,
	): Promise<boolean> {
		const tasks = [...this.tasks.values()].filter(
			(task) =>
				task.userId === userId &&
				task.chatId === chatId &&
				!task.done &&
				(!messageId || task.messageId === messageId),
		);
		let stopped = false;
		for (const task of tasks)
			stopped = (await stopGeneration(userId, task.messageId)) || stopped;
		traceSocket("socket chat tasks stopped", {
			userId,
			chatId,
			messageId,
			taskCount: tasks.length,
			stopped,
		});
		return stopped;
	}

	async stopTask(userId: string, messageId: string): Promise<boolean> {
		const task = this.tasks.get(messageId);
		if (!task || task.userId !== userId) return false;
		const stopped = await stopGeneration(userId, messageId);
		traceSocket("socket task stopped", { userId, messageId, stopped });
		return stopped;
	}

	private removeTask(messageId: string): void {
		const task = this.tasks.get(messageId);
		if (!task) return;
		if (task.cleanupTimer) clearTimeout(task.cleanupTimer);
		task.unsubscribe?.();
		this.tasks.delete(messageId);
	}

	close(): void {
		for (const task of this.tasks.values()) {
			if (task.cleanupTimer) clearTimeout(task.cleanupTimer);
			task.unsubscribe?.();
		}
		this.tasks.clear();
		this.socketUsers.clear();
	}
}
