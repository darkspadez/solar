import { describe, expect, test } from "bun:test";
import { completionData } from "./events";

describe("Open WebUI completion event adapter", () => {
	test("encodes text deltas in the shared events payload shape", () => {
		expect(completionData({ type: "text-delta", textDelta: "Hello" })).toEqual({
			done: false,
			choices: [{ delta: { content: "Hello" } }],
		});
	});

	test("encodes terminal usage and stop reason", () => {
		expect(
			completionData({
				type: "finish",
				finishReason: "stop",
				usage: { inputTokens: 3, outputTokens: 5 },
			}),
		).toEqual({
			done: true,
			choices: [{ delta: {} }],
			finish_reason: "stop",
			usage: { prompt_tokens: 3, completion_tokens: 5, total_tokens: 8 },
		});
	});

	test("encodes tool-call lifecycle chunks", () => {
		expect(
			completionData({
				type: "tool-call-start",
				toolCallId: "call-1",
				toolName: "search",
			}),
		).toMatchObject({
			done: false,
			choices: [
				{
					delta: {
						tool_calls: [
							{
								id: "call-1",
								function: { name: "search", arguments: "" },
							},
						],
					},
				},
			],
		});
	});
});
