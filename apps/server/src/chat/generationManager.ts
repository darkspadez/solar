import type { Context } from "@earendil-works/pi-ai";
import { db } from "../db";
import type { MessageStatus, ProviderCallPurpose } from "../db/schema";
import { piEventToUiChunks, type UiChunk } from "./adapter";
import type { GenerationParams, ModelSelection } from "./catalog";
import { generateTitle, streamChat } from "./models";
import { logger } from "../logger";
import type { ResolvedTool } from "./mcp";
import type {
	ChatProviderCall,
	ModelCallTelemetry,
	TelemetryMetadata,
} from "../context/telemetry";

async function recordProviderCallTelemetry(input: {
	id: string;
	conversationId: string;
	messageId: string;
	purpose: ProviderCallPurpose;
	call: ModelCallTelemetry;
}): Promise<void> {
	const { call } = input;
	await db
		.insertInto("provider_call_telemetry")
		.values({
			id: input.id,
			conversationId: input.conversationId,
			messageId: input.messageId,
			purpose: input.purpose,
			provider: call.provider,
			api: call.api,
			modelId: call.modelId,
			inputTokens: call.inputTokens ?? null,
			outputTokens: call.outputTokens ?? null,
			cacheReadTokens: call.cacheReadTokens ?? null,
			cacheWriteTokens: call.cacheWriteTokens ?? null,
			estimatedCostMicros: call.estimatedCostMicros ?? null,
			latencyMs: call.latencyMs ?? null,
			contextPolicySource: call.contextPolicySource ?? null,
			contextPolicyEnabled:
				call.contextPolicyEnabled === undefined
					? null
					: call.contextPolicyEnabled
						? 1
						: 0,
			contextPolicyState: call.contextPolicyState
				? JSON.stringify(call.contextPolicyState)
				: null,
			overflowed: call.overflowed ? 1 : 0,
			retryAttempt: call.retryAttempt ?? 0,
			compactionTokensBefore: call.compactionTokensBefore ?? null,
			compactionTokensAfter: call.compactionTokensAfter ?? null,
			createdAt: new Date().toISOString(),
		})
		.execute();
}

interface BufferedChunk {
	id: number;
	chunk: UiChunk;
}

interface Subscriber {
	push: (bc: BufferedChunk) => void;
	heartbeat: () => void;
	end: () => void;
}

interface Generation {
	messageId: string;
	conversationId: string;
	model: string;
	selection: ModelSelection;
	params: GenerationParams;
	chunks: BufferedChunk[];
	nextId: number;
	status: "running" | "done" | "error";
	controller: AbortController;
	subscribers: Set<Subscriber>;
	text: string;
	reasoning: string;
	parts: unknown | null;
	toolCalls: PersistedToolCall[];
	usage: {
		inputTokens: number;
		outputTokens: number;
		cacheReadTokens: number;
		cacheWriteTokens: number;
	};
	steps: unknown[];
	providerCalls: ChatProviderCall[];
	telemetry: TelemetryMetadata;
	persist: (result: {
		/** Ordered raw pi-ai messages (assistant/toolResult) from the tool loop,
		 * excluding the final continuation. */
		steps: unknown[];
		/** The final assistant continuation (possibly combined from streamed
		 * step fragments), or the whole message when there was no tool loop. */
		parts: unknown;
		status: MessageStatus;
		text: string;
	}) => Promise<void>;
}

interface PersistedToolCall {
	id: string;
	name: string;
	serverName?: string;
	remoteName?: string;
	args: string;
	status: "streaming" | "executing" | "complete" | "error";
	output?: string;
}

interface TitleGeneration {
	firstMessage: string;
	prompt: string;
	selection: ModelSelection;
	persistTitle: (title: string) => Promise<boolean>;
}

const encoder = new TextEncoder();
const sseChunk = (bc: BufferedChunk) =>
	encoder.encode(
		`id: ${bc.id}\nevent: message\ndata: ${JSON.stringify(bc.chunk)}\n\n`,
	);
const sseDone = () => encoder.encode(`event: message\ndata: [DONE]\n\n`);
const sseHeartbeat = () => encoder.encode(`: heartbeat\n\n`);

/** How long a finished generation stays resumable in memory after completion. */
const RETENTION_MS = 60_000;
const HEARTBEAT_MS = 15_000;
const TITLE_TIMEOUT_MS = 30_000;

/**
 * Owns server-side generation as a task decoupled from any HTTP request.
 *
 * - Generation runs against its own AbortController, not the request signal, so
 *   a client disconnect never cancels it — the completed message still persists.
 * - Chunks are buffered per message id; SSE subscribers replay missed chunks
 *   (via Last-Event-ID) then attach live. This is the WS-ready subscriber seam.
 * - Only `stop(messageId)` (an explicit user Stop) aborts a generation.
 *
 * In-memory + single-node by design (see ARCHITECTURE.md §5): buffers do not
 * survive a process restart mid-generation.
 */
export class GenerationManager {
	private generations = new Map<string, Generation>();

	/** Starts a decoupled generation for an already-persisted placeholder message. */
	start(opts: {
		conversationId: string;
		messageId: string;
		context: Context;
		selection: ModelSelection;
		params: GenerationParams;
		tools?: ResolvedTool[];
		titleGeneration?: TitleGeneration;
		telemetry?: TelemetryMetadata;
		persist: Generation["persist"];
		retryContext?: () => Promise<{
			context: Context;
			params: GenerationParams;
		}>;
	}): void {
		const gen: Generation = {
			messageId: opts.messageId,
			conversationId: opts.conversationId,
			model: `${opts.selection.provider}/${opts.selection.modelId}`,
			selection: opts.selection,
			params: opts.params,
			chunks: [],
			nextId: 1,
			status: "running",
			controller: new AbortController(),
			subscribers: new Set(),
			text: "",
			reasoning: "",
			parts: null,
			toolCalls: [],
			usage: {
				inputTokens: 0,
				outputTokens: 0,
				cacheReadTokens: 0,
				cacheWriteTokens: 0,
			},
			steps: [],
			providerCalls: [],
			telemetry: opts.telemetry ?? {},
			persist: opts.persist,
		};
		this.generations.set(opts.messageId, gen);
		logger
			.withMetadata({
				conversationId: opts.conversationId,
				messageId: opts.messageId,
				model: gen.model,
			})
			.info("generation started");
		void this.run(
			gen,
			opts.context,
			opts.tools,
			opts.titleGeneration,
			opts.retryContext,
		);
	}

	isActive(messageId: string): boolean {
		return this.generations.get(messageId)?.status === "running";
	}

	/** Explicit user Stop — the only thing that cancels a generation. */
	stop(messageId: string): boolean {
		const gen = this.generations.get(messageId);
		if (!gen || gen.status !== "running") return false;
		gen.controller.abort();
		return true;
	}

	/**
	 * Subscribe to a generation's stream as SSE, replaying any chunks after
	 * `lastEventId`. Cancelling the returned stream (client disconnect) only
	 * detaches the subscriber; it never aborts the generation.
	 */
	subscribe(messageId: string, lastEventId = 0): ReadableStream<Uint8Array> {
		const gen = this.generations.get(messageId);
		let subscriber: Subscriber | null = null;
		let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
		const clearHeartbeat = () => {
			if (heartbeatTimer) clearInterval(heartbeatTimer);
			heartbeatTimer = null;
		};

		return new ReadableStream<Uint8Array>({
			start: (controller) => {
				if (!gen) {
					controller.enqueue(sseDone());
					controller.close();
					return;
				}
				for (const bc of gen.chunks) {
					if (bc.id > lastEventId) controller.enqueue(sseChunk(bc));
				}
				if (gen.status !== "running") {
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
							/* stream already closed */
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
				gen.subscribers.add(subscriber);
				heartbeatTimer = setInterval(
					() => subscriber?.heartbeat(),
					HEARTBEAT_MS,
				);
			},
			cancel: () => {
				clearHeartbeat();
				if (gen && subscriber) gen.subscribers.delete(subscriber);
			},
		});
	}

	private async run(
		gen: Generation,
		context: Context,
		tools: ResolvedTool[] = [],
		titleGeneration?: TitleGeneration,
		retryContext?: () => Promise<{
			context: Context;
			params: GenerationParams;
		}>,
	): Promise<void> {
		const emit = (chunk: UiChunk) => {
			const bc: BufferedChunk = { id: gen.nextId++, chunk };
			gen.chunks.push(bc);
			for (const s of gen.subscribers) s.push(bc);
		};
		const toolDisplayNames = new Map(
			tools.map(({ tool, serverName, remoteName }) => [
				tool.name,
				{ serverName, remoteName },
			]),
		);

		emit({ type: "start", messageId: gen.messageId });

		const titlePromise = titleGeneration
			? this.generateTitle(
					gen.conversationId,
					gen.messageId,
					titleGeneration,
					gen.telemetry,
				)
			: null;

		try {
			let retryAttempted = false;
			while (true)
				try {
					const events = streamChat(
						context,
						gen.selection,
						gen.params,
						gen.controller.signal,
						tools,
						{
							telemetry: gen.telemetry,
							onGenerationStep: (step) => gen.steps.push(step),
							onProviderCall: (providerCall) => {
								gen.providerCalls.push(providerCall);
								const { error: _error, ...call } = providerCall.observation;
								gen.usage.inputTokens += call.inputTokens ?? 0;
								gen.usage.outputTokens += call.outputTokens ?? 0;
								gen.usage.cacheReadTokens += call.cacheReadTokens ?? 0;
								gen.usage.cacheWriteTokens += call.cacheWriteTokens ?? 0;
							},
						},
					);
					for await (const event of events) {
						if (event.type === "error") {
							throw new Error(event.error.errorMessage ?? "Generation failed");
						}
						if (event.type === "text_delta") gen.text += event.delta;
						if (event.type === "thinking_delta") gen.reasoning += event.delta;
						if (event.type === "done") {
							// Store the whole pi assistant message so context can be
							// reconstructed losslessly on later turns.
							gen.parts = event.message;
						}
						for (const chunk of piEventToUiChunks(event, toolDisplayNames)) {
							if (chunk.type === "tool-call-start") {
								gen.toolCalls.push({
									id: chunk.toolCallId,
									name: chunk.toolName,
									serverName: chunk.serverName,
									remoteName: chunk.remoteName,
									args: "",
									status: "streaming",
								});
							} else if (chunk.type === "tool-call-delta") {
								gen.toolCalls = gen.toolCalls.map((call) =>
									call.id === chunk.toolCallId
										? { ...call, args: call.args + chunk.argsText }
										: call,
								);
							} else if (chunk.type === "tool-call-end") {
								gen.toolCalls = gen.toolCalls.map((call) =>
									call.id === chunk.toolCallId
										? { ...call, status: "executing" }
										: call,
								);
							} else if (chunk.type === "tool-call-result") {
								gen.toolCalls = gen.toolCalls.map((call) =>
									call.id === chunk.toolCallId
										? {
												...call,
												output: chunk.output,
												status: chunk.isError ? "error" : "complete",
											}
										: call,
								);
							}
							emit(chunk);
						}
					}
					break;
				} catch (error) {
					const retrySafe =
						gen.providerCalls.at(-1)?.observation.error?.retrySafe;
					if (!retryAttempted && retrySafe && retryContext) {
						retryAttempted = true;
						const fresh = await retryContext();
						context = fresh.context;
						gen.params = fresh.params;
						gen.telemetry = { ...gen.telemetry, retryAttempt: 1 };
						continue;
					}
					throw error;
				}
			const title = titlePromise
				? await withTimeout(titlePromise, TITLE_TIMEOUT_MS)
				: null;
			if (title) emit({ type: "title-update", title });
			await this.persist(gen, "complete");
			gen.status = "done";
			logger
				.withMetadata({
					conversationId: gen.conversationId,
					messageId: gen.messageId,
					model: gen.model,
				})
				.trace(gen.text);
			logger
				.withMetadata({
					conversationId: gen.conversationId,
					messageId: gen.messageId,
					model: gen.model,
				})
				.info("generation completed");
		} catch (err) {
			if (gen.controller.signal.aborted) {
				// Explicit user Stop: keep the partial text, mark complete.
				emit({
					type: "finish",
					finishReason: "stop",
					usage: {
						inputTokens: gen.usage.inputTokens,
						outputTokens: gen.usage.outputTokens,
					},
				});
				await this.persist(gen, "complete");
				gen.status = "done";
				logger
					.withMetadata({
						conversationId: gen.conversationId,
						messageId: gen.messageId,
						model: gen.model,
					})
					.trace(gen.text);
				logger
					.withMetadata({
						conversationId: gen.conversationId,
						messageId: gen.messageId,
						model: gen.model,
					})
					.info("generation stopped");
			} else {
				const errorText = err instanceof Error ? err.message : String(err);
				gen.text = gen.text
					? `${gen.text}\n\n**Error:** ${errorText}`
					: `**Error:** ${errorText}`;
				emit({ type: "error", errorText });
				await this.persist(gen, "error");
				gen.status = "error";
				logger
					.withError(err)
					.withMetadata({
						conversationId: gen.conversationId,
						messageId: gen.messageId,
						model: gen.model,
					})
					.error("generation failed");
			}
		} finally {
			for (const s of gen.subscribers) s.end();
			gen.subscribers.clear();
			setTimeout(() => this.generations.delete(gen.messageId), RETENTION_MS);
		}
	}

	private async generateTitle(
		conversationId: string,
		messageId: string,
		generation: TitleGeneration,
		telemetry: TelemetryMetadata,
	): Promise<string | null> {
		const calls: ModelCallTelemetry[] = [];
		try {
			const response = await generateTitle(
				generation.prompt.replaceAll(
					"{{first_message}}",
					generation.firstMessage,
				),
				generation.selection,
				{
					telemetry,
					onProviderCall: ({ observation }) => {
						const { error: _error, ...call } = observation;
						calls.push(call);
					},
				},
			);
			const title = parseTitle(response);
			if (!title) return null;
			return (await generation.persistTitle(title)) ? title : null;
		} catch (error) {
			logger
				.withError(error)
				.withMetadata({ conversationId })
				.warn("title generation failed");
			return null;
		} finally {
			await Promise.all(
				calls.map((call) =>
					recordProviderCallTelemetry({
						id: crypto.randomUUID(),
						conversationId,
						messageId,
						purpose: "title",
						call,
					}),
				),
			);
		}
	}

	private async persist(gen: Generation, status: MessageStatus): Promise<void> {
		// The tool loop's intermediate assistant/toolResult messages must be
		// persisted as the ordered, separate pi-ai messages they actually are —
		// not flattened into one synthetic combined message.
		const persistedParts = withPersistedReasoning(gen.parts, gen.reasoning);
		await gen.persist({
			steps: gen.steps,
			parts: persistedParts,
			status,
			text: gen.text,
		});
		await Promise.all(
			gen.providerCalls.map(({ purpose, observation }) => {
				const { error: _error, ...call } = observation;
				return recordProviderCallTelemetry({
					id: crypto.randomUUID(),
					conversationId: gen.conversationId,
					messageId: gen.messageId,
					purpose,
					call,
				});
			}),
		);
	}
}

function withPersistedReasoning(parts: unknown, reasoning: string): unknown {
	if (!reasoning || !parts || typeof parts !== "object") return parts;

	const message = { ...(parts as Record<string, unknown>) };
	const content = Array.isArray(message.content) ? [...message.content] : [];
	const thinkingIndex = content.findIndex(
		(part) =>
			part != null &&
			typeof part === "object" &&
			(part as { type?: unknown }).type === "thinking",
	);
	if (thinkingIndex >= 0) {
		content[thinkingIndex] = {
			...(content[thinkingIndex] as Record<string, unknown>),
			thinking: reasoning,
		};
	} else {
		content.unshift({ type: "thinking", thinking: reasoning });
	}
	message.content = content;
	return message;
}

function parseTitle(response: string): string | null {
	const raw = response.trim();
	if (!raw) return null;
	try {
		const parsed = JSON.parse(raw) as { title?: unknown };
		if (typeof parsed.title === "string" && parsed.title.trim()) {
			return parsed.title.trim().slice(0, 200);
		}
	} catch {
		// A raw model response is the agreed fallback for invalid JSON.
	}
	return raw.slice(0, 200);
}

async function withTimeout<T>(
	promise: Promise<T>,
	timeoutMs: number,
): Promise<T | null> {
	return new Promise((resolve) => {
		const timer = setTimeout(() => resolve(null), timeoutMs);
		promise.then(
			(value) => {
				clearTimeout(timer);
				resolve(value);
			},
			() => {
				clearTimeout(timer);
				resolve(null);
			},
		);
	});
}

export const generationManager = new GenerationManager();
