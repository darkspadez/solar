/**
 * SOLAR_MOCK_LLM support for the pi engine: an OpenAI-completions-compatible
 * streaming endpoint served back to the pi child process (registered as the
 * `solar:mock:mock` provider in models.json; see ../models.ts). Mirrors the
 * canned reply shape of the legacy in-process mock (chat/models.ts
 * mockStream) so dev/E2E expectations keep their meaning across engines.
 */

interface OpenAiMessage {
	role: string;
	content: string | Array<{ type: string; text?: string }>;
}

function lastUserText(messages: OpenAiMessage[]): string {
	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index]!;
		if (message.role !== "user") continue;
		if (typeof message.content === "string") return message.content;
		return message.content
			.filter((part) => part.type === "text")
			.map((part) => part.text ?? "")
			.join("\n");
	}
	return "";
}

const encoder = new TextEncoder();

export async function serveMockChatCompletion(req: Request): Promise<Response> {
	let body: { model?: string; messages?: OpenAiMessage[] };
	try {
		body = await req.json();
	} catch {
		return Response.json({ error: "invalid json" }, { status: 400 });
	}
	const model = body.model ?? "mock-reasoning";
	const prompt = lastUserText(body.messages ?? []);
	const id = `chatcmpl-mock-${Date.now()}`;

	const chunk = (delta: Record<string, unknown>, finishReason: string | null = null) =>
		encoder.encode(
			`data: ${JSON.stringify({
				id,
				object: "chat.completion.chunk",
				created: Math.floor(Date.now() / 1000),
				model,
				choices: [{ index: 0, delta, finish_reason: finishReason }],
			})}\n\n`,
		);

	const reasoning = model === "mock-reasoning"
		? `Reasoning about: ${prompt}. Step 1: parse. Step 2: consider options. Step 3: answer.`
		: null;
	const reply =
		`**Mock reply** (${model}) to: ${prompt}\n\n` +
		"Inline code `x = 1`, a fenced block:\n\n" +
		'```js\nconsole.log("hello");\n```\n\n' +
		"And display math: $$E = mc^2$$\n\n" +
		"Sources: [React documentation](https://react.dev/), [MDN Web Docs](https://developer.mozilla.org/), [TypeScript handbook](https://www.typescriptlang.org/docs/), and [Bun documentation](https://bun.sh/docs).";

	const tokenize = (text: string) => text.match(/\S+\s*|\s+/g) ?? [text];

	const stream = new ReadableStream<Uint8Array>({
		async start(controller) {
			controller.enqueue(chunk({ role: "assistant" }));
			if (reasoning) {
				for (const token of tokenize(reasoning)) {
					await new Promise((resolve) => setTimeout(resolve, 5));
					controller.enqueue(chunk({ reasoning_content: token }));
				}
			}
			for (const token of tokenize(reply)) {
				await new Promise((resolve) => setTimeout(resolve, 5));
				controller.enqueue(chunk({ content: token }));
			}
			controller.enqueue(chunk({}, "stop"));
			controller.enqueue(
				encoder.encode(
					`data: ${JSON.stringify({
						id,
						object: "chat.completion.chunk",
						created: Math.floor(Date.now() / 1000),
						model,
						choices: [],
						usage: {
							prompt_tokens: 1,
							completion_tokens: tokenize(reply).length + (reasoning ? tokenize(reasoning).length : 0),
							total_tokens: 1,
						},
					})}\n\n`,
				),
			);
			controller.enqueue(encoder.encode("data: [DONE]\n\n"));
			controller.close();
		},
	});

	return new Response(stream, {
		headers: {
			"content-type": "text/event-stream",
			"cache-control": "no-cache",
		},
	});
}
