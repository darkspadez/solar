import { describe, expect, test } from "bun:test";
import type { CanonicalMessageRecord } from "./types";
import { repairDanglingToolCalls, validateMessageSequence } from "./validation";

let ordinal = 0;

function record(
	message: CanonicalMessageRecord["message"],
): CanonicalMessageRecord {
	return {
		id: `m${ordinal}`,
		conversationId: "conv",
		turnId: "turn",
		ordinal: ordinal++,
		role: message.role,
		message,
		origin: "text",
		status: "complete",
		createdAt: new Date(1_700_000_000_000 + ordinal * 1000).toISOString(),
	};
}

const usage = {
	input: 1,
	output: 1,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 2,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

const assistantWithCall = (...ids: string[]) =>
	record({
		role: "assistant",
		content: ids.map((id) => ({
			type: "toolCall" as const,
			id,
			name: "do_thing",
			arguments: {},
		})),
		api: "openai-completions",
		provider: "openai",
		model: "m",
		usage,
		stopReason: "toolUse",
		timestamp: Date.now(),
	});

const toolResult = (id: string) =>
	record({
		role: "toolResult",
		toolCallId: id,
		toolName: "do_thing",
		content: [{ type: "text" as const, text: "ok" }],
		isError: false,
		timestamp: Date.now(),
	});

const user = () =>
	record({
		role: "user",
		content: [{ type: "text" as const, text: "hi" }],
		timestamp: Date.now(),
	});

describe("repairDanglingToolCalls", () => {
	test("leaves healthy sequences untouched", () => {
		ordinal = 0;
		const records = [user(), assistantWithCall("call_A"), toolResult("call_A"), user()];
		const repaired = repairDanglingToolCalls(records);
		expect(repaired).toEqual(records);
		expect(() =>
			validateMessageSequence(repaired.map((r) => r.message)),
		).not.toThrow();
	});

	test("synthesizes an error result for a trailing dangling call", () => {
		ordinal = 0;
		const records = [user(), assistantWithCall("call_B")];
		const repaired = repairDanglingToolCalls(records);
		expect(repaired).toHaveLength(3);
		const synthetic = repaired.at(-1)!;
		expect(synthetic.role).toBe("toolResult");
		expect(synthetic.status).toBe("error");
		expect(synthetic.origin).toBe("legacy");
		expect(
			(synthetic.message as { isError: boolean }).isError,
		).toBe(true);
		expect(() =>
			validateMessageSequence(repaired.map((r) => r.message)),
		).not.toThrow();
	});

	test("handles the staging defect: same call id re-issued without a result", () => {
		ordinal = 0;
		const records = [
			user(),
			assistantWithCall("call_gll|fc_tmp"),
			toolResult("call_gll|fc_tmp"),
			assistantWithCall("call_gll|fc_tmp"),
		];
		const repaired = repairDanglingToolCalls(records);
		expect(repaired).toHaveLength(5);
		expect(repaired.at(-1)!.role).toBe("toolResult");
		expect(() =>
			validateMessageSequence(repaired.map((r) => r.message)),
		).not.toThrow();
	});

	test("closes out pending parallel calls before the next user message", () => {
		ordinal = 0;
		const records = [
			assistantWithCall("call_1", "call_2"),
			toolResult("call_1"),
			// call_2 never resolves; next message is a user turn
			user(),
		];
		const repaired = repairDanglingToolCalls(records);
		expect(repaired.map((r) => r.role)).toEqual([
			"assistant",
			"toolResult",
			"toolResult",
			"user",
		]);
		const synthetic = repaired[2]!;
		expect((synthetic.message as { toolCallId: string }).toolCallId).toBe(
			"call_2",
		);
		expect(() =>
			validateMessageSequence(repaired.map((r) => r.message)),
		).not.toThrow();
	});
});
