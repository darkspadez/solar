import type {
	CompleteAttachment,
	ThreadMessageLike,
} from "@assistant-ui/react";

export interface SolarAttachmentMeta {
	id: string;
	filename: string;
	mimeType: string;
	kind: "image" | "text" | "document";
}

export type SolarConnectionStatus = "connecting" | "request-sent";

export interface SolarMetrics {
	ttftMs: number | null;
	tps: number | null;
	e2e: number | null;
	inputTokens: number | null;
	outputTokens: number | null;
	reasoningTokens: number | null;
	cacheReadTokens: number | null;
	cacheWriteTokens: number | null;
}

export interface SolarSummaryEvent {
	tokensBefore: number | null;
	tokensAfter: number | null;
	revision: number | null;
	createdAt: string | null;
	position: "before" | "after";
}

export interface SolarToolCall {
	id: string;
	name: string;
	serverName?: string;
	remoteName?: string;
	args: string;
	status: "streaming" | "executing" | "complete" | "error";
	output?: string;
}

export interface SolarMessage {
	id: string;
	role: "user" | "assistant";
	content: string;
	createdAt?: string;
	connectionStatus?: SolarConnectionStatus;
	reasoning?: string;
	toolCalls?: SolarToolCall[];
	summaryEvent?: SolarSummaryEvent;
	attachments?: SolarAttachmentMeta[];
	skillInvocation?: { name: string } | null;
	metrics?: SolarMetrics;
}

export type TimelineItem =
	| { kind: "reasoning"; id: string; text: string }
	| { kind: "toolCalls"; id: string; calls: SolarToolCall[] }
	| { kind: "text"; id: string; text: string };

export function parseTimelineItems(
	partsStr: string | null | undefined,
	fallbackText: string,
	fallbackReasoning?: string,
	fallbackToolCalls?: SolarToolCall[],
): TimelineItem[] {
	let solarToolCalls: SolarToolCall[] = fallbackToolCalls ?? [];
	let contentParts: Array<{
		type?: string;
		thinking?: string;
		text?: string;
		id?: string;
		name?: string;
	}> = [];

	if (partsStr) {
		try {
			const parsed = JSON.parse(partsStr) as {
				content?: typeof contentParts;
				solarToolCalls?: SolarToolCall[];
			};
			if (Array.isArray(parsed.solarToolCalls))
				solarToolCalls = parsed.solarToolCalls;
			if (Array.isArray(parsed.content)) contentParts = parsed.content;
		} catch {
			// Ignore malformed persisted message parts.
		}
	}

	const toolMap = new Map(solarToolCalls.map((call) => [call.id, call]));
	const placedToolIds = new Set<string>();
	const items: TimelineItem[] = [];

	for (const part of contentParts) {
		if (part.type === "thinking" && part.thinking) {
			const last = items.at(-1);
			if (last?.kind === "reasoning") last.text += part.thinking;
			else
				items.push({
					kind: "reasoning",
					id: `reasoning-${items.length}`,
					text: part.thinking,
				});
		} else if (part.type === "toolCall") {
			if (part.id) placedToolIds.add(part.id);
			const call = (part.id ? toolMap.get(part.id) : undefined) ?? {
				id: part.id ?? `call-${items.length}`,
				name: part.name ?? "tool",
				args: "",
				status: "complete" as const,
			};
			const last = items.at(-1);
			if (last?.kind === "toolCalls") {
				if (!last.calls.some((existing) => existing.id === call.id))
					last.calls.push(call);
			} else {
				items.push({
					kind: "toolCalls",
					id: `tools-${items.length}`,
					calls: [call],
				});
			}
		} else if (part.type === "text" && part.text) {
			const last = items.at(-1);
			if (last?.kind === "text") last.text += part.text;
			else
				items.push({
					kind: "text",
					id: `text-${items.length}`,
					text: part.text,
				});
		}
	}

	const unplacedCalls = solarToolCalls.filter(
		(call) => !placedToolIds.has(call.id),
	);
	if (unplacedCalls.length > 0) {
		if (items.length === 0) {
			if (fallbackReasoning)
				items.push({
					kind: "reasoning",
					id: "reasoning-fallback",
					text: fallbackReasoning,
				});
			const paragraphs = fallbackText.split(/\n\n+/).filter(Boolean);
			if (paragraphs.length > 1) {
				paragraphs.forEach((text, index) => {
					items.push({ kind: "text", id: `text-p-${index}`, text });
					if (index < unplacedCalls.length)
						items.push({
							kind: "toolCalls",
							id: `tools-unplaced-${index}`,
							calls: [unplacedCalls[index]!],
						});
				});
				if (unplacedCalls.length > paragraphs.length)
					items.push({
						kind: "toolCalls",
						id: "tools-unplaced-remaining",
						calls: unplacedCalls.slice(paragraphs.length),
					});
			} else {
				items.push({
					kind: "toolCalls",
					id: "tools-unplaced-all",
					calls: unplacedCalls,
				});
				if (fallbackText)
					items.push({ kind: "text", id: "text-fallback", text: fallbackText });
			}
		} else {
			const textCount = items.filter((item) => item.kind === "text").length;
			if (textCount > 1) {
				const interleaved: TimelineItem[] = [];
				let callIndex = 0;
				for (const item of items) {
					interleaved.push(item);
					if (item.kind === "text" && callIndex < unplacedCalls.length)
						interleaved.push({
							kind: "toolCalls",
							id: `tools-interleaved-${callIndex}`,
							calls: [unplacedCalls[callIndex++]!],
						});
				}
				while (callIndex < unplacedCalls.length)
					interleaved.push({
						kind: "toolCalls",
						id: `tools-interleaved-${callIndex}`,
						calls: [unplacedCalls[callIndex++]!],
					});
				return interleaved;
			}
			const firstTextIndex = items.findIndex((item) => item.kind === "text");
			const tools = {
				kind: "toolCalls" as const,
				id: "tools-unplaced-group",
				calls: unplacedCalls,
			};
			if (firstTextIndex >= 0) items.splice(firstTextIndex, 0, tools);
			else items.push(tools);
		}
	} else if (items.length === 0) {
		if (fallbackReasoning)
			items.push({
				kind: "reasoning",
				id: "reasoning-fallback",
				text: fallbackReasoning,
			});
		if (fallbackText)
			items.push({ kind: "text", id: "text-fallback", text: fallbackText });
	}

	return items;
}

function toCompleteAttachment(
	attachment: SolarAttachmentMeta,
): CompleteAttachment {
	return {
		id: attachment.id,
		type: attachment.kind === "image" ? "image" : "document",
		name: attachment.filename,
		contentType: attachment.mimeType,
		status: { type: "complete" },
		content:
			attachment.kind === "image"
				? [{ type: "image", image: `/api/attachments/${attachment.id}` }]
				: [{ type: "text", text: "" }],
	};
}

export function convertMessage(message: SolarMessage): ThreadMessageLike {
	return {
		id: message.id,
		role: message.role,
		content: [
			...(message.reasoning
				? [{ type: "reasoning" as const, text: message.reasoning }]
				: []),
			{ type: "text", text: message.content },
		],
		attachments: message.attachments?.map(toCompleteAttachment),
		metadata: {
			custom: {
				createdAt: message.createdAt,
				connectionStatus: message.connectionStatus,
				toolCalls: message.toolCalls,
				summaryEvent: message.summaryEvent,
				skillInvocation: message.skillInvocation,
				metrics: message.metrics,
			},
		},
	};
}

export function parseMessageMetrics(
	parts: string | null | undefined,
): SolarMetrics | undefined {
	if (!parts) return undefined;
	try {
		const parsed = JSON.parse(parts) as {
			usage?: Record<string, unknown>;
			solarMetrics?: Partial<SolarMetrics>;
		};
		if (!parsed.usage && !parsed.solarMetrics) return undefined;
		const numberOrNull = (value: unknown) =>
			typeof value === "number" && Number.isFinite(value) ? value : null;
		return {
			ttftMs: numberOrNull(parsed.solarMetrics?.ttftMs),
			tps: numberOrNull(parsed.solarMetrics?.tps),
			e2e: numberOrNull(parsed.solarMetrics?.e2e),
			inputTokens: numberOrNull(parsed.usage?.input),
			outputTokens: numberOrNull(parsed.usage?.output),
			reasoningTokens: numberOrNull(parsed.usage?.reasoning),
			cacheReadTokens: numberOrNull(parsed.usage?.cacheRead),
			cacheWriteTokens: numberOrNull(parsed.usage?.cacheWrite),
		};
	} catch {
		return undefined;
	}
}
