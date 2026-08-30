/**
 * PiGenerationRegistry — the SSE chunk contract for pi-engine generations.
 *
 * Mirrors chat/generationManager.ts's observable behavior (buffered UiChunk
 * stream, Last-Event-ID replay, decoupled execution, 60s post-completion
 * retention) but persistence is pi's session file (the child process writes
 * it), not chat-v2 canonical messages. In-memory only, single-node — same
 * restart semantics as the legacy manager.
 */
import { randomUUID } from "node:crypto";
import type { UiChunk } from "../chat/adapter";

export interface BufferedChunk {
	id: number;
	chunk: UiChunk;
}
import { logger } from "../logger";

interface Subscriber {
	push: (bc: BufferedChunk) => void;
	heartbeat: () => void;
	end: () => void;
}

export interface PiGeneration {
	id: string;
	conversationId: string;
	userId: string;
	status: "running" | "done" | "error";
	chunks: BufferedChunk[];
	nextId: number;
	subscribers: Set<Subscriber>;
	onStop: (() => Promise<void> | void) | null;
	createdAt: number;
}

const encoder = new TextEncoder();
const sseChunk = (bc: BufferedChunk) =>
	encoder.encode(
		`id: ${bc.id}\nevent: message\ndata: ${JSON.stringify(bc.chunk)}\n\n`,
	);
const sseDone = () => encoder.encode(`event: message\ndata: [DONE]\n\n`);
const sseHeartbeat = () => encoder.encode(`: heartbeat\n\n`);

const RETENTION_MS = 60_000;
const HEARTBEAT_MS = 15_000;

class PiGenerationRegistry {
	private generations = new Map<string, PiGeneration>();

	start(input: { conversationId: string; userId: string }): PiGeneration {
		const generation: PiGeneration = {
			id: randomUUID(),
			conversationId: input.conversationId,
			userId: input.userId,
			status: "running",
			chunks: [],
			nextId: 1,
			subscribers: new Set(),
			onStop: null,
			createdAt: Date.now(),
		};
		this.generations.set(generation.id, generation);
		return generation;
	}

	get(id: string): PiGeneration | undefined {
		return this.generations.get(id);
	}

	owns(userId: string, id: string): boolean {
		const generation = this.generations.get(id);
		return generation !== undefined && generation.userId === userId;
	}

	isActive(id: string): boolean {
		return this.generations.get(id)?.status === "running";
	}

	isConversationGenerating(conversationId: string): boolean {
		for (const generation of this.generations.values()) {
			if (
				generation.conversationId === conversationId &&
				generation.status === "running"
			)
				return true;
		}
		return false;
	}

	emit(generation: PiGeneration, chunk: UiChunk): void {
		const bc: BufferedChunk = { id: generation.nextId++, chunk };
		generation.chunks.push(bc);
		for (const subscriber of generation.subscribers) subscriber.push(bc);
	}

	finish(generation: PiGeneration, status: "done" | "error"): void {
		if (generation.status !== "running") return;
		generation.status = status;
		for (const subscriber of generation.subscribers) subscriber.end();
		generation.subscribers.clear();
		setTimeout(() => this.generations.delete(generation.id), RETENTION_MS);
	}

	/** Explicit user Stop — aborts via the registered hook (pi abort command). */
	async stop(id: string): Promise<boolean> {
		const generation = this.generations.get(id);
		if (!generation || generation.status !== "running") return false;
		await generation.onStop?.();
		return true;
	}

	subscribe(id: string, lastEventId = 0): ReadableStream<Uint8Array> {
		const generation = this.generations.get(id);
		let subscriber: Subscriber | null = null;
		let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
		const clearHeartbeat = () => {
			if (heartbeatTimer) clearInterval(heartbeatTimer);
			heartbeatTimer = null;
		};

		return new ReadableStream<Uint8Array>({
			start: (controller) => {
				if (!generation) {
					controller.enqueue(sseDone());
					controller.close();
					return;
				}
				for (const bc of generation.chunks) {
					if (bc.id > lastEventId) controller.enqueue(sseChunk(bc));
				}
				if (generation.status !== "running") {
					controller.enqueue(sseDone());
					controller.close();
					return;
				}
				subscriber = {
					push: (bc) => {
						try {
							controller.enqueue(sseChunk(bc));
						} catch {
							/* stream already closed */
						}
					},
					heartbeat: () => {
						try {
							controller.enqueue(sseHeartbeat());
						} catch {
							/* closed */
						}
					},
					end: () => {
						clearHeartbeat();
						try {
							controller.enqueue(sseDone());
							controller.close();
						} catch {
							/* already closed */
						}
					},
				};
				generation.subscribers.add(subscriber);
				heartbeatTimer = setInterval(
					() => subscriber?.heartbeat(),
					HEARTBEAT_MS,
				);
			},
			cancel: () => {
				clearHeartbeat();
				if (generation && subscriber) generation.subscribers.delete(subscriber);
			},
		});
	}

	/** For force-stop / crash teardown: mark active generations interrupted. */
	interruptAllForConversation(conversationId: string, reason: string): void {
		for (const generation of this.generations.values()) {
			if (generation.conversationId !== conversationId) continue;
			if (generation.status !== "running") continue;
			this.emit(generation, { type: "error", errorText: reason });
			this.finish(generation, "error");
			logger
				.withMetadata({ conversationId, generationId: generation.id })
				.warn("pi generation interrupted");
		}
	}
}

export const piGenerations = new PiGenerationRegistry();
