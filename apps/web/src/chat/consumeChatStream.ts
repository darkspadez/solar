import type { Dispatch, MutableRefObject, SetStateAction } from "react";
import type {
	SolarConnectionStatus,
	SolarMetrics,
	SolarToolCall,
} from "./solarMessages";
import type { UiChunk } from "./streamTypes";

interface ConsumeChatStreamOptions {
	messageId: string;
	displayId: string;
	resetEventId: boolean;
	lastEventIdRef: MutableRefObject<number>;
	eventSourceRef: MutableRefObject<EventSource | null>;
	reconnectRef: MutableRefObject<(() => void) | null>;
	finishStreamRef: MutableRefObject<(() => void) | null>;
	assistantIdRef: MutableRefObject<string | null>;
	toolCallsByMessageRef: MutableRefObject<Map<string, SolarToolCall[]>>;
	metricsByMessageRef: MutableRefObject<Map<string, SolarMetrics>>;
	setIsRunning: Dispatch<SetStateAction<boolean>>;
	upsertAssistant: (
		id: string,
		text: string,
		reasoning?: string,
		toolCalls?: SolarToolCall[],
		connectionStatus?: SolarConnectionStatus,
		metrics?: SolarMetrics,
	) => void;
	onTitleUpdate: () => void;
}

export async function consumeChatStream({
	messageId,
	displayId,
	resetEventId,
	lastEventIdRef,
	eventSourceRef,
	reconnectRef,
	finishStreamRef,
	assistantIdRef,
	toolCallsByMessageRef,
	metricsByMessageRef,
	setIsRunning,
	upsertAssistant,
	onTitleUpdate,
}: ConsumeChatStreamOptions) {
	let text = "";
	let reasoning = "";
	let toolCalls: SolarToolCall[] = [];
	let source: EventSource | null = null;
	let connectionStartedAt: number | null = null;
	let firstTokenAt: number | null = null;
	let resolveCompletion: (() => void) | null = null;
	const completed = new Promise<void>((resolve) => {
		resolveCompletion = resolve;
	});
	finishStreamRef.current = resolveCompletion;

	const updateAssistant = (metrics?: SolarMetrics) =>
		upsertAssistant(
			displayId,
			text,
			reasoning || undefined,
			toolCalls,
			undefined,
			metrics,
		);
	const handleChunk = (chunk: UiChunk, eventId: string) => {
		const parsedId = Number(eventId);
		if (Number.isSafeInteger(parsedId) && parsedId <= lastEventIdRef.current)
			return;
		if (Number.isSafeInteger(parsedId)) lastEventIdRef.current = parsedId;
		if (chunk.type === "text-delta") {
			if (chunk.textDelta && firstTokenAt === null)
				firstTokenAt = performance.now();
			text += chunk.textDelta;
			updateAssistant();
		} else if (chunk.type === "reasoning-delta") {
			if (chunk.delta && firstTokenAt === null)
				firstTokenAt = performance.now();
			reasoning += chunk.delta;
			updateAssistant();
		} else if (chunk.type === "finish") {
			const endedAt = performance.now();
			const outputTokens = chunk.usage.outputTokens;
			const metrics: SolarMetrics = {
				ttftMs:
					connectionStartedAt !== null && firstTokenAt !== null
						? firstTokenAt - connectionStartedAt
						: null,
				tps:
					firstTokenAt !== null && outputTokens >= 0 && endedAt > firstTokenAt
						? outputTokens / ((endedAt - firstTokenAt) / 1000)
						: null,
				e2e:
					connectionStartedAt !== null &&
					outputTokens >= 0 &&
					endedAt > connectionStartedAt
						? outputTokens / ((endedAt - connectionStartedAt) / 1000)
						: null,
				inputTokens: chunk.usage.inputTokens ?? null,
				outputTokens: chunk.usage.outputTokens ?? null,
				reasoningTokens: chunk.usage.reasoningTokens ?? null,
				cacheReadTokens: chunk.usage.cacheReadTokens ?? null,
				cacheWriteTokens: chunk.usage.cacheWriteTokens ?? null,
			};
			metricsByMessageRef.current.set(messageId, metrics);
			updateAssistant(metrics);
		} else if (chunk.type === "tool-call-start") {
			toolCalls = [
				...toolCalls,
				{
					id: chunk.toolCallId,
					name: chunk.toolName,
					serverName: chunk.serverName,
					remoteName: chunk.remoteName,
					args: "",
					status: "streaming",
				},
			];
			updateAssistant();
		} else if (chunk.type === "tool-call-delta") {
			toolCalls = toolCalls.map((call) =>
				call.id === chunk.toolCallId
					? { ...call, args: call.args + chunk.argsText }
					: call,
			);
			updateAssistant();
		} else if (chunk.type === "tool-call-end") {
			toolCalls = toolCalls.map((call) =>
				call.id === chunk.toolCallId ? { ...call, status: "executing" } : call,
			);
			updateAssistant();
		} else if (chunk.type === "tool-call-result") {
			toolCalls = toolCalls.map((call) =>
				call.id === chunk.toolCallId
					? {
							...call,
							output: chunk.output,
							status: chunk.isError ? "error" : "complete",
						}
					: call,
			);
			updateAssistant();
		} else if (chunk.type === "error") {
			text += `\n\n_Error: ${chunk.errorText}_`;
			updateAssistant();
		} else if (chunk.type === "title-update") {
			onTitleUpdate();
		}
	};

	const connect = () => {
		source?.close();
		connectionStartedAt ??= performance.now();
		const query = new URLSearchParams({ messageId });
		if (lastEventIdRef.current > 0)
			query.set("lastEventId", String(lastEventIdRef.current));
		source = new EventSource(`/api/chat/stream?${query}`);
		eventSourceRef.current = source;
		source.onmessage = (event) => {
			if (event.data === "[DONE]") {
				source?.close();
				resolveCompletion?.();
				return;
			}
			handleChunk(JSON.parse(event.data) as UiChunk, event.lastEventId);
		};
		source.onerror = () => {
			if (source?.readyState === EventSource.CLOSED) resolveCompletion?.();
		};
	};

	reconnectRef.current = connect;
	setIsRunning(true);
	upsertAssistant(displayId, "", undefined, undefined, "request-sent");
	if (resetEventId) lastEventIdRef.current = 0;
	connect();
	try {
		await completed;
	} finally {
		eventSourceRef.current?.close();
		eventSourceRef.current = null;
		if (reconnectRef.current === connect) reconnectRef.current = null;
		if (finishStreamRef.current === resolveCompletion)
			finishStreamRef.current = null;
		if (toolCalls.length && assistantIdRef.current)
			toolCallsByMessageRef.current.set(assistantIdRef.current, toolCalls);
		setIsRunning(false);
		assistantIdRef.current = null;
	}
}
