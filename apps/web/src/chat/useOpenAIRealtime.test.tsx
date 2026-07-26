import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, renderHook, waitFor } from "@testing-library/react";
import { useOpenAIRealtime } from "./useOpenAIRealtime";

class FakeDataChannel {
	onopen: ((event: Event) => void) | null = null;
	onmessage: ((event: MessageEvent) => void) | null = null;
	sent: string[] = [];

	emit(event: object) {
		this.onmessage?.({ data: JSON.stringify(event) } as MessageEvent);
	}

	send(data: string) {
		this.sent.push(data);
	}
}

class FakePeerConnection {
	static instances: FakePeerConnection[] = [];
	readonly channel = new FakeDataChannel();
	ontrack: ((event: RTCTrackEvent) => void) | null = null;

	constructor() {
		FakePeerConnection.instances.push(this);
	}

	addTrack() {}
	close() {}
	createDataChannel() {
		return this.channel;
	}
	async createOffer() {
		return { type: "offer" as const, sdp: "test-offer" };
	}
	async setLocalDescription() {}
	async setRemoteDescription() {
		this.channel.onopen?.(new Event("open"));
	}
}

const realFetch = globalThis.fetch;
const realPeerConnection = globalThis.RTCPeerConnection;
const mediaDevicesDescriptor = Object.getOwnPropertyDescriptor(
	navigator,
	"mediaDevices",
);
let fetchCount = 0;
let tokenHistory: Array<{ role: "user" | "assistant"; text: string }> = [];
let audioTrack = { enabled: true, stop() {} };

globalThis.RTCPeerConnection =
	FakePeerConnection as unknown as typeof RTCPeerConnection;
Object.defineProperty(navigator, "mediaDevices", {
	configurable: true,
	value: {
		getUserMedia: async () => ({
			getTracks: () => [audioTrack],
			getAudioTracks: () => [audioTrack],
		}),
	},
});
globalThis.fetch = (async () => {
	fetchCount += 1;
	if (fetchCount % 2 === 1) {
		return Response.json({
			value: "ephemeral-token",
			realtimeUrl: "/realtime",
			history: tokenHistory,
		});
	}
	return new Response("test-answer");
}) as unknown as typeof fetch;

afterAll(() => {
	globalThis.fetch = realFetch;
	globalThis.RTCPeerConnection = realPeerConnection;
	if (mediaDevicesDescriptor) {
		Object.defineProperty(navigator, "mediaDevices", mediaDevicesDescriptor);
	} else {
		Reflect.deleteProperty(navigator, "mediaDevices");
	}
});

beforeEach(() => {
	fetchCount = 0;
	FakePeerConnection.instances = [];
	tokenHistory = [];
	audioTrack = { enabled: true, stop() {} };
});

describe("useOpenAIRealtime", () => {
	test("seeds text-only history before enabling microphone audio", async () => {
		tokenHistory = [
			{ role: "user", text: "Earlier question" },
			{ role: "assistant", text: "Earlier answer" },
		];
		const { result } = renderHook(() =>
			useOpenAIRealtime("conversation-1", async () => undefined),
		);

		await act(() => result.current.start());
		const sent = FakePeerConnection.instances[0]!.channel.sent.map((event) =>
			JSON.parse(event),
		);
		expect(sent).toEqual([
			{
				type: "conversation.item.create",
				item: {
					type: "message",
					role: "user",
					content: [{ type: "input_text", text: "Earlier question" }],
				},
			},
			{
				type: "conversation.item.create",
				item: {
					type: "message",
					role: "assistant",
					content: [{ type: "output_text", text: "Earlier answer" }],
				},
			},
		]);
		expect(audioTrack.enabled).toBe(false);
		expect(result.current.activity).toBe("connecting");
		const channel = FakePeerConnection.instances[0]!.channel;
		act(() => channel.emit({ type: "conversation.item.added" }));
		expect(audioTrack.enabled).toBe(false);
		act(() => channel.emit({ type: "conversation.item.added" }));
		expect(audioTrack.enabled).toBe(true);
		expect(result.current.activity).toBe("listening");
	});

	test("reports voice activity and retains transcripts until persistence completes", async () => {
		let releasePersistence!: () => void;
		const persistence = new Promise<void>((resolve) => {
			releasePersistence = resolve;
		});
		const onTurnComplete = mock(async () => persistence);
		const { result } = renderHook(() =>
			useOpenAIRealtime("conversation-1", onTurnComplete),
		);

		await act(() => result.current.start());
		expect(result.current.activity).toBe("listening");
		const channel = FakePeerConnection.instances[0]!.channel;

		act(() => channel.emit({ type: "input_audio_buffer.speech_started" }));
		expect(result.current.activity).toBe("user-speaking");
		act(() =>
			channel.emit({
				type: "conversation.item.input_audio_transcription.delta",
				delta: "Hello",
			}),
		);
		act(() => channel.emit({ type: "input_audio_buffer.speech_stopped" }));
		expect(result.current.activity).toBe("assistant-speaking");
		act(() =>
			channel.emit({
				type: "response.output_audio_transcript.delta",
				delta: "Hi there",
			}),
		);
		act(() =>
			channel.emit({
				type: "response.done",
				response: { id: "response-1", status: "completed" },
			}),
		);

		expect(onTurnComplete).toHaveBeenCalledWith("Hello", "Hi there");
		expect(result.current.userTranscript).toBe("Hello");
		expect(result.current.assistantTranscript).toBe("Hi there");

		await act(async () => releasePersistence());
		await waitFor(() => expect(result.current.userTranscript).toBe(""));
		expect(result.current.assistantTranscript).toBe("");
		expect(result.current.activity).toBe("listening");
	});

	test("waits for delayed user transcription before completing a turn", async () => {
		const onTurnComplete = mock(async () => undefined);
		const { result } = renderHook(() =>
			useOpenAIRealtime("conversation-1", onTurnComplete),
		);
		await act(() => result.current.start());
		const channel = FakePeerConnection.instances[0]!.channel;

		act(() =>
			channel.emit({
				type: "response.output_audio_transcript.delta",
				delta: "Delayed reply",
			}),
		);
		act(() =>
			channel.emit({
				type: "response.done",
				response: { id: "response-1", status: "completed" },
			}),
		);
		expect(onTurnComplete).not.toHaveBeenCalled();

		act(() =>
			channel.emit({
				type: "conversation.item.input_audio_transcription.completed",
				transcript: "Delayed question",
			}),
		);
		await waitFor(() =>
			expect(onTurnComplete).toHaveBeenCalledWith(
				"Delayed question",
				"Delayed reply",
			),
		);
	});

	test("ignores cancelled response completion while a new turn starts", async () => {
		const onTurnComplete = mock(async () => undefined);
		const { result } = renderHook(() =>
			useOpenAIRealtime("conversation-1", onTurnComplete),
		);
		await act(() => result.current.start());
		const channel = FakePeerConnection.instances[0]!.channel;

		act(() =>
			channel.emit({
				type: "response.done",
				response: { id: "cancelled-response", status: "cancelled" },
			}),
		);
		act(() =>
			channel.emit({
				type: "conversation.item.input_audio_transcription.completed",
				transcript: "New question",
			}),
		);
		act(() =>
			channel.emit({
				type: "response.output_audio_transcript.done",
				transcript: "New answer",
			}),
		);
		expect(onTurnComplete).not.toHaveBeenCalled();

		act(() =>
			channel.emit({
				type: "response.done",
				response: { id: "new-response", status: "completed" },
			}),
		);
		await waitFor(() =>
			expect(onTurnComplete).toHaveBeenCalledWith("New question", "New answer"),
		);
	});
});
