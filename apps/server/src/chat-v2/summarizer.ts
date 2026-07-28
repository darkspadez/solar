import type { Message } from "@earendil-works/pi-ai";
import {
	MOCK,
	resolveModel,
	resolveTaskModelOrFallback,
	streamModel,
	type ModelSelection,
} from "../chat/catalog";
import type { CompactionSummarizer } from "./compaction";

const PROMPT_VERSION = "solar-chat-v2-compaction-summary-v1";

function renderMessage(message: Message): string {
	if (message.role === "user") {
		const text =
			typeof message.content === "string"
				? message.content
				: message.content
						.map((part) =>
							part.type === "text"
								? part.text
								: part.type === "image"
									? "[image attachment]"
									: "",
						)
						.filter(Boolean)
						.join(" ");
		return text ? `user: ${text}` : "";
	}
	if (message.role === "assistant") {
		const text = message.content
			.map((part) =>
				part.type === "text"
					? part.text
					: part.type === "toolCall"
						? `[called tool ${part.name}]`
						: "",
			)
			.filter(Boolean)
			.join(" ");
		return text ? `assistant: ${text}` : "";
	}
	if (message.role === "toolResult") {
		const text = message.content
			.map((part) => (part.type === "text" ? part.text : "[image result]"))
			.filter(Boolean)
			.join(" ");
		return text ? `tool result (${message.toolName}): ${text}` : "";
	}
	return "";
}

function buildPrompt(messages: readonly Message[]): string {
	const transcript = messages.map(renderMessage).filter(Boolean).join("\n\n");
	return `${PROMPT_VERSION}

Summarize the following conversation excerpt. Preserve durable, task-relevant
information only: goals, constraints, decisions, durable facts, unresolved
questions, and important tool outcomes. Be concise. Do not answer the
conversation; return only the summary.

Conversation excerpt:

${transcript}`;
}

function deterministicSummary(messageCount: number): string {
	return `Rolling summary of ${messageCount} compacted messages.`;
}

/**
 * Builds a real compaction summarizer bound to a conversation's task model
 * (falling back per `resolveTaskModelOrFallback`, same as v1). Used to run
 * compaction jobs immediately after they are enqueued, not deferred to any
 * external scheduler.
 */
export function createV2Summarizer(
	selection: ModelSelection,
): CompactionSummarizer {
	return async ({ messages }) => {
		if (MOCK) return deterministicSummary(messages.length);
		const taskSelection =
			selection.provider === "mock"
				? selection
				: await resolveTaskModelOrFallback(selection);
		if (taskSelection.provider === "mock")
			return deterministicSummary(messages.length);
		const resolved = await resolveModel(taskSelection);
		const prompt = buildPrompt(messages);
		let text = "";
		for await (const event of streamModel(
			resolved,
			{ messages: [{ role: "user", content: prompt, timestamp: Date.now() }] },
			new AbortController().signal,
		)) {
			if (event.type === "text_delta") text += event.delta;
			if (event.type === "error")
				throw new Error(event.error.errorMessage ?? "Compaction summary failed");
		}
		if (!text.trim()) throw new Error("Compaction summary returned empty text");
		return text.trim();
	};
}
