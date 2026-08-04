const TRACE_BODY_LIMIT_BYTES = 8 * 1024;
const sensitiveField =
	/authorization|cookie|token|password|secret|api[-_]?key/i;
const contentField = /content|text|prompt|message|output|input|reasoning/i;

function summarizeTraceValue(value: unknown): unknown {
	if (value === null || typeof value === "boolean" || typeof value === "number")
		return value;
	if (typeof value === "string") return { stringLength: value.length };
	if (Array.isArray(value))
		return {
			arrayLength: value.length,
			items: value.slice(0, 10).map(summarizeTraceValue),
		};
	if (!value || typeof value !== "object") return typeof value;
	return Object.fromEntries(
		Object.entries(value as Record<string, unknown>).map(([key, item]) => [
			key,
			sensitiveField.test(key)
				? "<redacted>"
				: contentField.test(key) && typeof item === "string"
					? { stringLength: item.length }
					: summarizeTraceValue(item),
		]),
	);
}

/**
 * Summarizes a JSON request body without consuming the request that the
 * handler still needs to parse.
 *
 * Bun's incoming request bodies are tee'd when cloned. Cancelling a clone's
 * reader can remain pending until the original body is consumed, so the
 * cancellation must not be awaited here.
 */
export async function traceJsonBody(payload: Request | Response) {
	const headers = payload.headers;
	const contentType = headers.get("content-type") ?? "";
	if (!contentType.includes("application/json") || !payload.body)
		return { contentType, body: "<not-json>" };

	const reader = payload.clone().body?.getReader();
	if (!reader) return { contentType, body: "<not-json>" };

	const chunks: Uint8Array[] = [];
	let length = 0;
	let truncated = false;
	try {
		while (length <= TRACE_BODY_LIMIT_BYTES) {
			const { done, value } = await reader.read();
			if (done) break;
			chunks.push(value);
			length += value.byteLength;
		}
		truncated = length > TRACE_BODY_LIMIT_BYTES;
	} catch {
		return { contentType, body: "<unavailable>" };
	} finally {
		// Do not await this. With a large request body, Bun may wait for the
		// original request reader before resolving cancellation of this clone.
		void reader.cancel().catch(() => {});
	}
	if (truncated) return { contentType, bodyBytes: length, truncated: true };

	const bytes = new Uint8Array(length);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.byteLength;
	}
	try {
		return {
			contentType,
			bodyBytes: length,
			body: summarizeTraceValue(JSON.parse(new TextDecoder().decode(bytes))),
		};
	} catch {
		return { contentType, bodyBytes: length, body: "<invalid-json>" };
	}
}
