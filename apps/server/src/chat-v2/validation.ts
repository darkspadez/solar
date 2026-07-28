import type {
	AssistantMessage,
	Message,
	ToolResultMessage,
	Usage,
	UserMessage,
} from "@earendil-works/pi-ai";
import type { DiagnosticIds } from "./types";

export class CanonicalMessageValidationError extends Error {
	readonly conversationId?: string;
	readonly turnId?: string;
	readonly messageId?: string;
	readonly generationId?: string;
	readonly compactionId?: string;
	readonly ordinal?: number;

	constructor(reason: string, diagnostics: DiagnosticIds = {}) {
		const context = [
			diagnostics.conversationId && `conversation=${diagnostics.conversationId}`,
			diagnostics.turnId && `turn=${diagnostics.turnId}`,
			diagnostics.messageId && `message=${diagnostics.messageId}`,
			diagnostics.generationId && `generation=${diagnostics.generationId}`,
			diagnostics.compactionId && `compaction=${diagnostics.compactionId}`,
			diagnostics.ordinal !== undefined && `ordinal=${diagnostics.ordinal}`,
		]
			.filter(Boolean)
			.join(" ");
		super(context ? `${reason} (${context})` : reason);
		this.name = "CanonicalMessageValidationError";
		Object.assign(this, diagnostics);
	}
}

export interface MessageValidationContext extends DiagnosticIds {}

function fail(reason: string, context?: MessageValidationContext): never {
	throw new CanonicalMessageValidationError(reason, context);
}

function record(value: unknown, name: string, context?: MessageValidationContext) {
	if (!value || typeof value !== "object" || Array.isArray(value))
		fail(`${name} must be an object`, context);
	return value as Record<string, unknown>;
}

function nonEmptyString(value: unknown, name: string, context?: MessageValidationContext) {
	if (typeof value !== "string" || value.length === 0)
		fail(`${name} must be a non-empty string`, context);
	return value;
}

/**
 * Some content fields are typed as `string` but may legitimately be empty,
 * e.g. `ThinkingContent.thinking` when the provider redacted the visible
 * reasoning text and stored the real payload in `thinkingSignature`.
 */
function typedString(value: unknown, name: string, context?: MessageValidationContext) {
	if (typeof value !== "string") fail(`${name} must be a string`, context);
	return value;
}

function finiteNumber(value: unknown, name: string, context?: MessageValidationContext) {
	if (typeof value !== "number" || !Number.isFinite(value))
		fail(`${name} must be a finite number`, context);
	return value;
}

function nonNegativeNumber(value: unknown, name: string, context?: MessageValidationContext) {
	const number = finiteNumber(value, name, context);
	if (number < 0) fail(`${name} must not be negative`, context);
	return number;
}

function validateTimestamp(value: unknown, context?: MessageValidationContext) {
	finiteNumber(value, "timestamp", context);
}

function validateTextOrImageContent(
	content: unknown,
	name: string,
	context?: MessageValidationContext,
) {
	if (!Array.isArray(content)) fail(`${name} must be an array`, context);
	for (const [index, part] of content.entries()) {
		const block = record(part, `${name}[${index}]`, context);
		if (block.type === "text") typedString(block.text, `${name}[${index}].text`, context);
		else if (block.type === "image") {
			nonEmptyString(block.data, `${name}[${index}].data`, context);
			nonEmptyString(block.mimeType, `${name}[${index}].mimeType`, context);
		} else fail(`${name}[${index}].type must be text or image`, context);
	}
}

function validateAssistantContent(content: unknown, context?: MessageValidationContext) {
	if (!Array.isArray(content)) fail("assistant.content must be an array", context);
	for (const [index, part] of content.entries()) {
		const block = record(part, `assistant.content[${index}]`, context);
		if (block.type === "text")
			typedString(block.text, `assistant.content[${index}].text`, context);
		else if (block.type === "thinking")
			typedString(block.thinking, `assistant.content[${index}].thinking`, context);
		else if (block.type === "toolCall") {
			nonEmptyString(block.id, `assistant.content[${index}].id`, context);
			nonEmptyString(block.name, `assistant.content[${index}].name`, context);
			record(block.arguments, `assistant.content[${index}].arguments`, context);
		} else fail(`assistant.content[${index}].type is invalid`, context);
	}
}

export function zeroUsage(): Usage {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function validateUsage(value: unknown, context?: MessageValidationContext): Usage {
	const usage = record(value, "assistant.usage", context);
	for (const key of ["input", "output", "cacheRead", "cacheWrite", "totalTokens"])
		nonNegativeNumber(usage[key], `assistant.usage.${key}`, context);
	if (usage.reasoning !== undefined)
		nonNegativeNumber(usage.reasoning, "assistant.usage.reasoning", context);
	if (usage.cacheWrite1h !== undefined)
		nonNegativeNumber(usage.cacheWrite1h, "assistant.usage.cacheWrite1h", context);
	const cost = record(usage.cost, "assistant.usage.cost", context);
	for (const key of ["input", "output", "cacheRead", "cacheWrite", "total"])
		nonNegativeNumber(cost[key], `assistant.usage.cost.${key}`, context);
	return usage as unknown as Usage;
}

export function parseCanonicalMessage(
	input: unknown,
	context?: MessageValidationContext,
): Message {
	const message = record(input, "message", context);
	validateTimestamp(message.timestamp, context);
	if (message.role === "user") {
		if (typeof message.content !== "string")
			validateTextOrImageContent(message.content, "user.content", context);
		return message as unknown as UserMessage;
	}
	if (message.role === "assistant") {
		validateAssistantContent(message.content, context);
		nonEmptyString(message.api, "assistant.api", context);
		nonEmptyString(message.provider, "assistant.provider", context);
		nonEmptyString(message.model, "assistant.model", context);
		validateUsage(message.usage, context);
		if (!new Set(["stop", "length", "toolUse", "error", "aborted"]).has(message.stopReason as string))
			fail("assistant.stopReason is invalid", context);
		return message as unknown as AssistantMessage;
	}
	if (message.role === "toolResult") {
		nonEmptyString(message.toolCallId, "toolResult.toolCallId", context);
		nonEmptyString(message.toolName, "toolResult.toolName", context);
		validateTextOrImageContent(message.content, "toolResult.content", context);
		if (typeof message.isError !== "boolean")
			fail("toolResult.isError must be a boolean", context);
		return message as unknown as ToolResultMessage;
	}
	fail("message.role must be user, assistant, or toolResult", context);
}

export function validateToolPairing(
	messages: readonly Message[],
	contexts: readonly MessageValidationContext[] = [],
): void {
	const pending = new Map<string, { name: string; context: MessageValidationContext }>();
	for (const [index, message] of messages.entries()) {
		const context = contexts[index] ?? { ordinal: index };
		if (pending.size > 0 && message.role !== "toolResult") {
			const [id] = pending.entries().next().value!;
			fail(`tool call ${id} must receive a result before the next ${message.role} message`, context);
		}
		if (message.role === "assistant") {
			for (const part of message.content) {
				if (part.type !== "toolCall") continue;
				if (pending.has(part.id))
					fail(`duplicate unresolved tool call ID ${part.id}`, context);
				pending.set(part.id, { name: part.name, context });
			}
			continue;
		}
		if (message.role !== "toolResult") continue;
		const call = pending.get(message.toolCallId);
		if (!call) fail(`tool result ${message.toolCallId} has no preceding tool call`, context);
		if (call.name !== message.toolName)
			fail(`tool result ${message.toolCallId} name does not match ${call.name}`, context);
		pending.delete(message.toolCallId);
	}
	const unresolved = pending.entries().next().value;
	if (unresolved) {
		const [id, call] = unresolved;
		fail(`tool call ${id} has no result`, call.context);
	}
}

export function validateMessageSequence(
	messages: readonly Message[],
	contexts: readonly MessageValidationContext[] = [],
): void {
	for (const [index, message] of messages.entries())
		parseCanonicalMessage(message, contexts[index] ?? { ordinal: index });
	validateToolPairing(messages, contexts);
}
