import type { UiChunk } from "../chat/adapter";

export function completionData(chunk: UiChunk): Record<string, unknown> {
	switch (chunk.type) {
		case "start":
			return { done: false, choices: [{ delta: {} }] };
		case "text-delta":
			return {
				done: false,
				choices: [{ delta: { content: chunk.textDelta } }],
			};
		case "reasoning-delta":
			return {
				done: false,
				choices: [{ delta: { reasoning_content: chunk.delta } }],
			};
		case "tool-call-start":
			return {
				done: false,
				choices: [
					{
						delta: {
							tool_calls: [
								{
									index: 0,
									id: chunk.toolCallId,
									type: "function",
									function: { name: chunk.toolName, arguments: "" },
								},
							],
						},
					},
				],
			};
		case "tool-call-delta":
			return {
				done: false,
				choices: [
					{
						delta: {
							tool_calls: [
								{
									index: 0,
									id: chunk.toolCallId,
									function: { arguments: chunk.argsText },
								},
							],
						},
					},
				],
			};
		case "tool-call-end":
			return { done: false, choices: [{ delta: {} }] };
		case "tool-call-result":
			return {
				done: false,
				choices: [{ delta: { content: chunk.output } }],
				...(chunk.isError ? { error: { message: chunk.output } } : {}),
			};
		case "finish":
			return {
				done: true,
				choices: [{ delta: {} }],
				finish_reason: chunk.finishReason,
				usage: {
					prompt_tokens: chunk.usage.inputTokens,
					completion_tokens: chunk.usage.outputTokens,
					total_tokens: chunk.usage.inputTokens + chunk.usage.outputTokens,
				},
			};
		case "title-update":
			return { done: true, title: chunk.title, choices: [{ delta: {} }] };
		case "error":
			return {
				done: true,
				choices: [],
				error: { message: chunk.errorText },
			};
	}
}
