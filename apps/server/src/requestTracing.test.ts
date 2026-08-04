import { describe, expect, test } from "bun:test";
import { traceJsonBody } from "./requestTracing";

describe("request tracing", () => {
	test("does not block a large incoming JSON request after truncating its clone", async () => {
		const server = Bun.serve({
			port: 0,
			async fetch(request) {
				const trace = await traceJsonBody(request);
				const body = (await request.json()) as { data: string };
				return Response.json({
					trace,
					dataLength: body.data.length,
				});
			},
		});

		try {
			const data = "x".repeat(100_000);
			const response = await fetch(server.url, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ data }),
				signal: AbortSignal.timeout(2_000),
			});

			expect(response.status).toBe(200);
			expect(await response.json()).toMatchObject({
				trace: {
					contentType: "application/json",
					truncated: true,
				},
				dataLength: data.length,
			});
		} finally {
			server.stop();
		}
	});
});
