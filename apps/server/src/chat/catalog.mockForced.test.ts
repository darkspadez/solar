import { describe, expect, test } from "bun:test";

// Mock-mode guard: any stored/fallback selection pointing at a live provider
// must be redirected to the default mock model so dev traffic stays free.
process.env.SOLAR_MOCK_LLM = "1";

const { mockForcedSelection } = await import("./catalog");

describe("mockForcedSelection", () => {
	test("redirects a live-provider selection to the default mock model", () => {
		expect(
			mockForcedSelection({
				provider: "Plexus",
				endpointId: "endpoint-1",
				modelId: "gemini-3.7-flash",
				api: "google-generative-ai",
			}),
		).toEqual({
			provider: "mock",
			endpointId: "mock",
			modelId: "mock-reasoning",
			api: "mock",
		});
	});

	test("passes mock selections through unchanged", () => {
		const vision = {
			provider: "mock",
			endpointId: "mock",
			modelId: "mock-vision",
			api: "mock",
		};
		expect(mockForcedSelection(vision)).toEqual(vision);
	});
});
