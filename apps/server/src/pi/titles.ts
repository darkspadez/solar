/**
 * Title generation for pi conversations — a one-shot provider call Solar
 * drives itself (not a pi turn: we never want the title prompt persisted
 * into the session file). chat-v2's telemetry side effects are gone with
 * the legacy engine.
 */
import type { Context } from "@earendil-works/pi-ai";
import {
	mockForcedSelection,
	resolveModel,
	type ModelSelection,
} from "../chat/catalog";
import { streamModel } from "../chat/catalog";

export async function generatePiTitleText(
	firstMessage: string,
	prompt: string,
	selection: ModelSelection,
): Promise<string | null> {
	// Mock-mode guard: titles are opportunistic background LLM calls and must
	// never reach a live provider in dev (SOLAR_MOCK_LLM).
	selection = mockForcedSelection(selection);
	const finalPrompt = prompt.replaceAll("{{first_message}}", firstMessage);
	// Mock dev generator: echo back a bounded, title-shaped string so the UI
	// path works without a provider.
	if (selection.provider === "mock") {
		return `Mock: ${firstMessage.slice(0, 60)}`;
	}
	const resolved = await resolveModel(selection);
	const context: Context = {
		messages: [{ role: "user", content: finalPrompt, timestamp: Date.now() }],
	};
	let text = "";
	for await (const event of streamModel(
		resolved,
		context,
		new AbortController().signal,
	)) {
		if (event.type === "error") {
			throw new Error(event.error.errorMessage ?? "title generation failed");
		}
		if (event.type === "text_delta") text += event.delta;
	}
	const trimmed = text.trim();
	if (!trimmed) return null;
	try {
		const parsed = JSON.parse(trimmed) as { title?: unknown };
		if (typeof parsed.title === "string" && parsed.title.trim()) {
			return parsed.title.trim().slice(0, 200);
		}
	} catch {
		// non-JSON answer → use raw
	}
	return trimmed.slice(0, 200);
}
