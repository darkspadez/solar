import { convertToLlm, createCompactionSummaryMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, Message, ToolResultMessage, UserMessage } from "@earendil-works/pi-ai";
import { zeroUsage } from "./validation";

const TIMESTAMP = 1_700_000_000_000;
const SYNTHETIC_API = "openai-completions";
const SYNTHETIC_PROVIDER = "solar-fixture";
const SYNTHETIC_MODEL = "fixture-model";

function user(text: string, timestamp: number): UserMessage {
	return { role: "user", content: text, timestamp };
}

function assistant(
	content: AssistantMessage["content"],
	timestamp: number,
	overrides: Partial<AssistantMessage> = {},
): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: SYNTHETIC_API,
		provider: SYNTHETIC_PROVIDER,
		model: SYNTHETIC_MODEL,
		usage: zeroUsage(),
		stopReason: "stop",
		timestamp,
		...overrides,
	};
}

export function plainTextExchange(): Message[] {
	return [user("Hello", TIMESTAMP), assistant([{ type: "text", text: "Hi." }], TIMESTAMP + 1)];
}

export function reasoningAssistantMessage(): AssistantMessage {
	return assistant(
		[
			{ type: "thinking", thinking: "I should answer concisely." },
			{ type: "text", text: "A concise answer." },
		],
		TIMESTAMP,
	);
}

export function toolCallResultContinuation(): Message[] {
	const toolCallId = "weather-1";
	const toolName = "weather";
	const result: ToolResultMessage = {
		role: "toolResult",
		toolCallId,
		toolName,
		content: [{ type: "text", text: "20 C and clear" }],
		isError: false,
		timestamp: TIMESTAMP + 2,
	};
	return [
		user("What is the weather?", TIMESTAMP),
		assistant(
			[{ type: "toolCall", id: toolCallId, name: toolName, arguments: { city: "Austin" } }],
			TIMESTAMP + 1,
			{ stopReason: "toolUse" },
		),
		result,
		assistant([{ type: "text", text: "It is 20 C and clear in Austin." }], TIMESTAMP + 3),
	];
}

export function imageAndTextAttachmentMessage(): UserMessage {
	return {
		role: "user",
		content: [
			{ type: "text", text: "Describe this image." },
			{ type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" },
		],
		timestamp: TIMESTAMP,
	};
}

export function voiceTranscriptPair(): Message[] {
	return [
		user("Please summarize the meeting.", TIMESTAMP),
		assistant([{ type: "text", text: "The meeting covered launch timing." }], TIMESTAMP + 1),
	];
}

export function stoppedGeneration(): AssistantMessage {
	return assistant([{ type: "text", text: "Partial response" }], TIMESTAMP, {
		stopReason: "aborted",
	});
}

export function failedGeneration(): AssistantMessage {
	return assistant([], TIMESTAMP, {
		stopReason: "error",
		errorMessage: "Provider request failed",
	});
}

export function compactionReplacementRange(): Message[] {
	return convertToLlm([
		createCompactionSummaryMessage("The user asked about launch timing.", 120, new Date(TIMESTAMP).toISOString()),
	]);
}
