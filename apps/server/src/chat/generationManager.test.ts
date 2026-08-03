import { beforeEach, describe, expect, mock, test } from "bun:test";

const providerCallInserts: Array<Record<string, unknown>> = [];
const persisted: Array<{
	steps: unknown[];
	parts: unknown;
	status: string;
	text: string;
}> = [];
let streamFactory: (...args: any[]) => AsyncIterable<any>;
let titleFactory: (...args: any[]) => Promise<string>;
let persistStarted: Promise<void> | null = null;
let notifyPersistStarted: (() => void) | null = null;
let persistGate: Promise<void> | null = null;
let releasePersist: (() => void) | null = null;
let notifyPersistFinished: (() => void) | null = null;

mock.module("../db", () => ({
	db: {
		insertInto(table: string) {
			const query = {
				values(values: Record<string, unknown>) {
					if (table === "provider_call_telemetry")
						providerCallInserts.push(values);
					return query;
				},
				execute: async () => undefined,
			};
			return query;
		},
	},
}));

const log = {
	withMetadata: () => log,
	withError: () => log,
	info: () => undefined,
	trace: () => undefined,
	warn: () => undefined,
	error: () => undefined,
};

mock.module("../logger", () => ({ logger: log }));
mock.module("./models", () => ({
	streamChat: (...args: any[]) => streamFactory(...args),
	generateTitle: (...args: any[]) => titleFactory(...args),
}));

const { GenerationManager } = await import("./generationManager");

type SseEvent = { id?: number; data: unknown };

async function readEvents(
	stream: ReadableStream<Uint8Array>,
): Promise<SseEvent[]> {
	return readReader(stream.getReader());
}

async function readReader(
	reader: ReadableStreamDefaultReader<Uint8Array>,
): Promise<SseEvent[]> {
	const decoder = new TextDecoder();
	const events: SseEvent[] = [];

	while (true) {
		const { done, value } = await reader.read();
		if (done) return events;
		const fields = decoder.decode(value).trim().split("\n");
		const id = fields.find((field) => field.startsWith("id: "));
		const data = fields.find((field) => field.startsWith("data: "))?.slice(6);
		events.push({
			...(id ? { id: Number(id.slice(4)) } : {}),
			data: data === "[DONE]" ? data : JSON.parse(data ?? "null"),
		});
	}
}

async function* events(...values: any[]): AsyncGenerator<any> {
	yield* values;
}

async function persistCall(result: {
	steps: unknown[];
	parts: unknown;
	status: string;
	text: string;
}): Promise<void> {
	if (notifyPersistStarted && persistGate) {
		const notify = notifyPersistStarted;
		const gate = persistGate;
		notifyPersistStarted = null;
		persistGate = null;
		notify();
		await gate;
		notifyPersistFinished?.();
		notifyPersistFinished = null;
	}
	persisted.push(result);
}

function start(
	manager: InstanceType<typeof GenerationManager>,
	messageId = "message-1",
	overrides: Partial<
		Parameters<InstanceType<typeof GenerationManager>["start"]>[0]
	> = {},
): void {
	manager.start({
		conversationId: "conversation-1",
		messageId,
		context: {} as never,
		selection: {
			provider: "test",
			endpointId: "test",
			modelId: "model",
			api: "test",
		},
		params: {} as never,
		persist: persistCall,
		...overrides,
	});
}

const doneEvent = {
	type: "done",
	reason: "stop",
	message: { usage: { input: 3, output: 5 } },
};

describe("GenerationManager SSE lifecycle", () => {
	beforeEach(() => {
		persisted.length = 0;
		providerCallInserts.length = 0;
		streamFactory = () => events();
		titleFactory = async () => "";
		persistStarted = null;
		notifyPersistStarted = null;
		persistGate = null;
		releasePersist = null;
		notifyPersistFinished = null;
	});

	test("streams start, chunks, finish, and completion to a live subscriber", async () => {
		streamFactory = () =>
			events(
				{ type: "text_delta", delta: "Hello" },
				{ type: "thinking_delta", delta: "Thinking" },
				doneEvent,
			);
		const manager = new GenerationManager();

		start(manager);

		expect(await readEvents(manager.subscribe("message-1"))).toEqual([
			{ id: 1, data: { type: "start", messageId: "message-1" } },
			{ id: 2, data: { type: "text-delta", textDelta: "Hello" } },
			{ id: 3, data: { type: "reasoning-delta", delta: "Thinking" } },
			{
				id: 4,
				data: {
					type: "finish",
					finishReason: "stop",
					usage: { inputTokens: 3, outputTokens: 5 },
				},
			},
			{ data: "[DONE]" },
		]);
		expect(manager.isActive("message-1")).toBe(false);
		expect(persisted).toEqual([
			expect.objectContaining({ status: "complete", text: "Hello" }),
		]);
	});

	test("delegates persistence entirely to the caller-provided callback", async () => {
		streamFactory = () =>
			events(
				{ type: "text_delta", delta: "v2 response" },
				{
					...doneEvent,
					message: {
						role: "assistant",
						content: [{ type: "text", text: "v2 response" }],
						usage: { input: 3, output: 5 },
					},
				},
			);
		const manager = new GenerationManager();
		start(manager, "v2-turn");

		await readEvents(manager.subscribe("v2-turn"));
		expect(persisted).toEqual([
			expect.objectContaining({ status: "complete", text: "v2 response" }),
		]);
	});

	test("persists streamed reasoning when the final provider message omits it", async () => {
		streamFactory = () =>
			events(
				{ type: "thinking_delta", delta: "First " },
				{ type: "thinking_delta", delta: "second" },
				{
					type: "done",
					reason: "stop",
					message: {
						role: "assistant",
						content: [{ type: "text", text: "Answer" }],
						usage: { input: 3, output: 5 },
					},
				},
			);
		const manager = new GenerationManager();

		start(manager);
		await readEvents(manager.subscribe("message-1"));

		const parts = persisted[0]?.parts as { content: unknown[] };
		expect(parts.content).toEqual([
			{ type: "thinking", thinking: "First second" },
			{ type: "text", text: "Answer" },
		]);
	});

	test("replays only events after the requested SSE event id", async () => {
		streamFactory = () =>
			events({ type: "text_delta", delta: "Hello" }, doneEvent);
		const manager = new GenerationManager();

		start(manager);
		await readEvents(manager.subscribe("message-1"));

		expect(await readEvents(manager.subscribe("message-1", 1))).toEqual([
			{ id: 2, data: { type: "text-delta", textDelta: "Hello" } },
			{
				id: 3,
				data: {
					type: "finish",
					finishReason: "stop",
					usage: { inputTokens: 3, outputTokens: 5 },
				},
			},
			{ data: "[DONE]" },
		]);
	});

	test("replays buffered chunks to a non-SSE subscriber", async () => {
		streamFactory = () =>
			events({ type: "text_delta", delta: "Hello" }, doneEvent);
		const manager = new GenerationManager();
		start(manager);

		const initial: Array<{ id: number; chunk: unknown }> = [];
		await new Promise<void>((resolve) => {
			manager.subscribeChunks("message-1", 0, {
				chunk: (bufferedChunk) => initial.push(bufferedChunk),
				end: resolve,
			});
		});
		expect(initial).toEqual([
			{ id: 1, chunk: { type: "start", messageId: "message-1" } },
			{ id: 2, chunk: { type: "text-delta", textDelta: "Hello" } },
			{
				id: 3,
				chunk: {
					type: "finish",
					finishReason: "stop",
					usage: { inputTokens: 3, outputTokens: 5 },
				},
			},
		]);

		const replayed: Array<{ id: number; chunk: unknown }> = [];
		expect(
			manager.replayChunks("message-1", 1, (bufferedChunk) =>
				replayed.push(bufferedChunk),
			),
		).toBe(true);
		expect(replayed.map(({ id }) => id)).toEqual([2, 3]);
	});

	test("does not publish completion before the response is persisted", async () => {
		let releaseGeneration!: () => void;
		const generationReleased = new Promise<void>((resolve) => {
			releaseGeneration = resolve;
		});
		persistStarted = new Promise<void>((resolve) => {
			notifyPersistStarted = resolve;
		});
		persistGate = new Promise<void>((resolve) => {
			releasePersist = resolve;
		});
		const persistFinished = new Promise<void>((resolve) => {
			notifyPersistFinished = resolve;
		});
		streamFactory = async function* () {
			yield { type: "text_delta", delta: "Long response" };
			await generationReleased;
			yield doneEvent;
		};
		const manager = new GenerationManager();
		start(manager);

		const first = manager.subscribe("message-1").getReader();
		await first.read();
		await first.read();
		releaseGeneration();
		await persistStarted;

		const resumed = manager.subscribe("message-1").getReader();
		expect((await resumed.read()).value).toBeDefined();
		expect((await resumed.read()).value).toBeDefined();
		expect((await resumed.read()).value).toBeDefined();
		expect(manager.isActive("message-1")).toBe(true);

		releasePersist?.();
		await persistFinished;
		expect((await resumed.read()).value).toBeDefined();
		expect((await resumed.read()).done).toBe(true);
		expect(manager.isActive("message-1")).toBe(false);
	});

	test("ends an unknown generation subscription immediately", async () => {
		const manager = new GenerationManager();

		expect(await readEvents(manager.subscribe("missing"))).toEqual([
			{ data: "[DONE]" },
		]);
		expect(manager.stop("missing")).toBe(false);
	});

	test("explicit stop aborts the stream, persists partial text, and emits a stop finish", async () => {
		streamFactory = async function* (
			_context,
			_selection,
			_params,
			signal: AbortSignal,
		) {
			yield { type: "text_delta", delta: "Partial" };
			yield* awaitAbort(signal);
		};
		const manager = new GenerationManager();

		start(manager);
		const stream = manager.subscribe("message-1");
		const reader = stream.getReader();
		await reader.read();
		await reader.read();
		expect(manager.stop("message-1")).toBe(true);

		expect(await readReader(reader)).toEqual([
			{
				id: 3,
				data: {
					type: "finish",
					finishReason: "stop",
					usage: { inputTokens: 0, outputTokens: 0 },
				},
			},
			{ data: "[DONE]" },
		]);
		expect(persisted).toEqual([
			expect.objectContaining({ status: "complete", text: "Partial" }),
		]);
	});

	test("emits an error chunk, closes subscribers, and persists failure state", async () => {
		streamFactory = () =>
			events(
				{ type: "text_delta", delta: "Partial" },
				{ type: "error", error: { errorMessage: "provider unavailable" } },
			);
		const manager = new GenerationManager();

		start(manager);

		expect(await readEvents(manager.subscribe("message-1"))).toEqual([
			{ id: 1, data: { type: "start", messageId: "message-1" } },
			{ id: 2, data: { type: "text-delta", textDelta: "Partial" } },
			{ id: 3, data: { type: "error", errorText: "provider unavailable" } },
			{ data: "[DONE]" },
		]);
		expect(persisted).toEqual([
			expect.objectContaining({
				status: "error",
				text: "Partial\n\n**Error:** provider unavailable",
			}),
		]);
	});

	test("passes native tool-loop steps to persist and records every provider call while aggregating usage", async () => {
		streamFactory = async function* (
			_context,
			_selection,
			_params,
			_signal,
			_tools,
			options,
		) {
			options.onGenerationStep({
				role: "assistant",
				content: [
					{ type: "toolCall", id: "call-1", name: "weather", arguments: {} },
				],
			});
			options.onGenerationStep({
				role: "toolResult",
				toolCallId: "call-1",
				toolName: "weather",
				content: [{ type: "text", text: "sunny" }],
				isError: false,
			});
			options.onProviderCall({
				purpose: "chat",
				observation: {
					provider: "test",
					api: "test",
					modelId: "model",
					inputTokens: 3,
					outputTokens: 5,
					cacheReadTokens: 2,
					cacheWriteTokens: 1,
					estimatedCostMicros: 4,
					latencyMs: 10,
				},
			});
			options.onProviderCall({
				purpose: "tool_loop",
				observation: {
					provider: "test",
					api: "test",
					modelId: "model",
					inputTokens: 7,
					outputTokens: 11,
					latencyMs: 12,
				},
			});
			yield {
				...doneEvent,
				message: {
					...doneEvent.message,
					api: "test",
					provider: "test",
					model: "model",
				},
			};
		};
		const manager = new GenerationManager();

		start(manager);
		await readEvents(manager.subscribe("message-1"));

		expect(persisted).toEqual([
			expect.objectContaining({
				steps: [
					expect.objectContaining({ role: "assistant" }),
					expect.objectContaining({ role: "toolResult" }),
				],
			}),
		]);
		expect(providerCallInserts).toEqual([
			expect.objectContaining({
				purpose: "chat",
				inputTokens: 3,
				cacheReadTokens: 2,
				cacheWriteTokens: 1,
				estimatedCostMicros: 4,
			}),
			expect.objectContaining({
				purpose: "tool_loop",
				inputTokens: 7,
				latencyMs: 12,
			}),
		]);
	});

	test("records title calls with their originating conversation and message", async () => {
		titleFactory = async (_prompt, _selection, options) => {
			options.onProviderCall({
				purpose: "chat",
				observation: {
					provider: "title-provider",
					api: "test",
					modelId: "title-model",
					inputTokens: 2,
					outputTokens: 3,
					latencyMs: 4,
				},
			});
			return '{"title":"A title"}';
		};
		streamFactory = () => events(doneEvent);
		const manager = new GenerationManager();
		const persistedTitles: (string | undefined)[] = [];

		start(manager, "message-1", {
			titleGeneration: {
				firstMessage: "Hello",
				prompt: "{{first_message}}",
				selection: {
					provider: "title-provider",
					endpointId: "test",
					modelId: "title-model",
					api: "test",
				},
				persistTitle: async (title) => {
					persistedTitles.push(title);
					return true;
				},
			},
		});
		await readEvents(manager.subscribe("message-1"));

		expect(persistedTitles).toEqual(["A title"]);
		expect(providerCallInserts).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					purpose: "title",
					conversationId: "conversation-1",
					messageId: "message-1",
					inputTokens: 2,
				}),
			]),
		);
	});

	test("persists overflow telemetry when a provider call fails", async () => {
		streamFactory = async function* (
			_context,
			_selection,
			_params,
			_signal,
			_tools,
			options,
		) {
			options.onProviderCall({
				purpose: "chat",
				observation: {
					provider: "test",
					api: "test",
					modelId: "model",
					inputTokens: 9,
					outputTokens: 0,
					cacheReadTokens: 4,
					cacheWriteTokens: 2,
					latencyMs: 10,
					overflowed: true,
					error: {
						kind: "context_overflow",
						retrySafe: true,
						outputStarted: false,
						toolStepsCompleted: false,
					},
				},
			});
			yield { type: "error", error: { errorMessage: "context exceeded" } };
		};
		const manager = new GenerationManager();

		start(manager);
		await readEvents(manager.subscribe("message-1"));

		expect(providerCallInserts).toEqual([
			expect.objectContaining({
				overflowed: 1,
				cacheReadTokens: 4,
				cacheWriteTokens: 2,
			}),
		]);
		expect(persisted).toEqual([expect.objectContaining({ status: "error" })]);
	});

	test("compacts and retries exactly once after safe overflow before output", async () => {
		let calls = 0;
		let rebuilt = 0;
		streamFactory = async function* (
			_context,
			_selection,
			_params,
			_signal,
			_tools,
			options,
		) {
			calls++;
			if (calls === 1) {
				options.onProviderCall({
					purpose: "chat",
					observation: {
						provider: "test",
						api: "test",
						modelId: "model",
						overflowed: true,
						retryAttempt: 0,
						error: {
							kind: "context_overflow",
							retrySafe: true,
							outputStarted: false,
							toolStepsCompleted: false,
						},
					},
				});
				yield { type: "error", error: { errorMessage: "context exceeded" } };
				return;
			}
			expect(options.telemetry.retryAttempt).toBe(1);
			yield { type: "text_delta", delta: "Recovered" };
			yield doneEvent;
		};
		const manager = new GenerationManager();
		start(manager, "message-1", {
			retryContext: async () => {
				rebuilt++;
				return { context: { messages: [] }, params: {} as never };
			},
		});
		expect(await readEvents(manager.subscribe("message-1"))).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					data: { type: "text-delta", textDelta: "Recovered" },
				}),
			]),
		);
		expect({ calls, rebuilt }).toEqual({ calls: 2, rebuilt: 1 });
		expect(providerCallInserts).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ retryAttempt: 0, overflowed: 1 }),
			]),
		);
	});

	test("does not retry overflow after streamed output", async () => {
		let rebuilt = 0;
		streamFactory = async function* (
			_context,
			_selection,
			_params,
			_signal,
			_tools,
			options,
		) {
			options.onProviderCall({
				purpose: "chat",
				observation: {
					provider: "test",
					api: "test",
					modelId: "model",
					overflowed: true,
					error: {
						kind: "context_overflow",
						retrySafe: false,
						outputStarted: true,
						toolStepsCompleted: false,
					},
				},
			});
			yield { type: "text_delta", delta: "Partial" };
			yield { type: "error", error: { errorMessage: "context exceeded" } };
		};
		const manager = new GenerationManager();
		start(manager, "message-1", {
			retryContext: async () => {
				rebuilt++;
				return { context: { messages: [] }, params: {} as never };
			},
		});
		await readEvents(manager.subscribe("message-1"));
		expect(rebuilt).toBe(0);
	});
});

async function* awaitAbort(signal: AbortSignal): AsyncGenerator<never> {
	await new Promise<never>((_resolve, reject) => {
		signal.addEventListener("abort", () => reject(new Error("aborted")), {
			once: true,
		});
	});
}
