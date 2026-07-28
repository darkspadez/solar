import { describe, expect, test } from "bun:test";
import { fauxProvider } from "@earendil-works/pi-ai";
import { transformMessages } from "@earendil-works/pi-ai/api/transform-messages";
import {
	compactionReplacementRange,
	failedGeneration,
	imageAndTextAttachmentMessage,
	plainTextExchange,
	reasoningAssistantMessage,
	stoppedGeneration,
	toolCallResultContinuation,
	voiceTranscriptPair,
} from "./fixtures";
import {
	CanonicalMessageValidationError,
	parseCanonicalMessage,
	validateMessageSequence,
} from "./validation";

describe("chat-v2 contracts", () => {
	test("serializes and validates every M0 fixture", () => {
		const fixtures = [
			plainTextExchange(),
			[reasoningAssistantMessage()],
			toolCallResultContinuation(),
			[imageAndTextAttachmentMessage()],
			voiceTranscriptPair(),
			[stoppedGeneration()],
			[failedGeneration()],
			compactionReplacementRange(),
		];
		for (const messages of fixtures) {
			const restored = JSON.parse(JSON.stringify(messages));
			expect(() => validateMessageSequence(restored)).not.toThrow();
		}
	});

	test("tool fixture passes pi-ai transformation", () => {
		const provider = fauxProvider({
			models: [{ id: "fixture-model", input: ["text", "image"] }],
		});
		const transformed = transformMessages(toolCallResultContinuation(), provider.getModel());
		expect(transformed).toHaveLength(4);
		expect(transformed[2]).toMatchObject({ role: "toolResult", toolCallId: "weather-1" });
	});

	test("reports invalid role, usage, timestamp, and tool pairing diagnostics", () => {
		expect(() => parseCanonicalMessage({ role: "system", content: "no", timestamp: 1 }, { conversationId: "c1", messageId: "m1", ordinal: 2 })).toThrow(
			"message.role must be user, assistant, or toolResult (conversation=c1 message=m1 ordinal=2)",
		);
		const missingUsage: Record<string, unknown> = {
			...reasoningAssistantMessage(),
		};
		delete missingUsage.usage;
		expect(() => parseCanonicalMessage(missingUsage)).toThrow("assistant.usage must be an object");
		expect(() => parseCanonicalMessage({ role: "user", content: "late", timestamp: "now" })).toThrow(
			"timestamp must be a finite number",
		);
		const orphaned = toolCallResultContinuation().slice(2);
		expect(() => validateMessageSequence(orphaned, [{ conversationId: "c2", ordinal: 8 }])).toThrow(
			"tool result weather-1 has no preceding tool call (conversation=c2 ordinal=8)",
		);
	});

	test("exposes structured diagnostics on validation errors", () => {
		try {
			parseCanonicalMessage({ role: "invalid", timestamp: 1 }, { conversationId: "c1", turnId: "t1", messageId: "m1", generationId: "g1", compactionId: "x1" });
			expect.unreachable();
		} catch (error) {
			expect(error).toBeInstanceOf(CanonicalMessageValidationError);
			expect(error).toMatchObject({ conversationId: "c1", turnId: "t1", messageId: "m1", generationId: "g1", compactionId: "x1" });
		}
	});
});
