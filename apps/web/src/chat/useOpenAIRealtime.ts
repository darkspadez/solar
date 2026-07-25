import { useCallback, useEffect, useRef, useState } from "react";

export type OpenAIRealtimeStatus = "disconnected" | "connecting" | "active";

export interface UseOpenAIRealtimeResult {
	status: OpenAIRealtimeStatus;
	error: Error | null;
	userTranscript: string;
	assistantTranscript: string;
	start: () => Promise<void>;
	stop: () => void;
}

interface RealtimeEvent {
	type?: string;
	delta?: string;
	error?: { message?: string };
	item?: { id?: string; role?: string };
}

interface RealtimeTokenResponse {
	value?: string;
	client_secret?: { value?: string };
	realtimeUrl?: string;
}

export function useOpenAIRealtime(
	conversationId: string,
	onTurnComplete?: (userText: string, assistantText: string) => void,
): UseOpenAIRealtimeResult {
	const [status, setStatus] = useState<OpenAIRealtimeStatus>("disconnected");
	const [error, setError] = useState<Error | null>(null);
	const [userTranscript, setUserTranscript] = useState("");
	const [assistantTranscript, setAssistantTranscript] = useState("");
	
	const peerConnectionRef = useRef<RTCPeerConnection | null>(null);
	const mediaStreamRef = useRef<MediaStream | null>(null);
	const audioRef = useRef<HTMLAudioElement | null>(null);
	const tokenRequestRef = useRef<AbortController | null>(null);
	
	const userTranscriptRef = useRef("");
	const assistantTranscriptRef = useRef("");
	const assistantItemIdRef = useRef<string | null>(null);
	const onTurnCompleteRef = useRef(onTurnComplete);
	const sessionIdRef = useRef(0);
	const disconnectTimerRef = useRef<Timer | null>(null);

	useEffect(() => {
		onTurnCompleteRef.current = onTurnComplete;
	}, [onTurnComplete]);

	const clearTranscripts = useCallback(() => {
		userTranscriptRef.current = "";
		assistantTranscriptRef.current = "";
		setUserTranscript("");
		setAssistantTranscript("");
	}, []);

	const cleanupConnection = useCallback(() => {
		tokenRequestRef.current?.abort();
		tokenRequestRef.current = null;
		
		peerConnectionRef.current?.close();
		peerConnectionRef.current = null;
		
		mediaStreamRef.current?.getTracks().forEach((track) => track.stop());
		mediaStreamRef.current = null;
		
		if (audioRef.current) {
			audioRef.current.srcObject = null;
			audioRef.current.remove();
			audioRef.current = null;
		}
	}, []);

	const stop = useCallback(() => {
		// Immediately update UI
		setStatus("disconnected");
		
		// Disable the microphone track immediately so user stops transmitting
		mediaStreamRef.current?.getAudioTracks().forEach((track) => {
			track.enabled = false;
			track.stop();
		});

		// Wait 10 seconds before tearing down the connection 
		// to allow any in-flight assistant responses to finish streaming
		if (disconnectTimerRef.current) {
			clearTimeout(disconnectTimerRef.current);
		}
		
		const currentSessionId = sessionIdRef.current;
		disconnectTimerRef.current = setTimeout(() => {
			if (sessionIdRef.current === currentSessionId) {
				cleanupConnection();
			}
		}, 10000);
		
	}, [cleanupConnection]);

	const start = useCallback(async () => {
		if (status !== "disconnected") return;

		const sessionId = ++sessionIdRef.current;
		if (disconnectTimerRef.current) {
			clearTimeout(disconnectTimerRef.current);
			disconnectTimerRef.current = null;
		}
		
		// If there is an existing connection, clean it up before starting a new one
		cleanupConnection();

		const isCurrentSession = () => sessionIdRef.current === sessionId;
		setStatus("connecting");
		setError(null);
		clearTranscripts();

		try {
			const tokenRequest = new AbortController();
			tokenRequestRef.current = tokenRequest;
			const tokenResponse = await fetch(
				`/api/chat/realtime-token?${new URLSearchParams({ conversationId })}`,
				{ signal: tokenRequest.signal },
			);
			if (!tokenResponse.ok) {
				const errText = await tokenResponse.text();
				throw new Error(`Realtime token request failed: ${errText}`);
			}
			const tokenData = (await tokenResponse.json()) as RealtimeTokenResponse;
			const ephemeralToken = tokenData.value ?? tokenData.client_secret?.value;
			if (!ephemeralToken) throw new Error("Realtime token response was invalid");
			if (!isCurrentSession()) return;

			const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
			if (!isCurrentSession()) {
				stream.getTracks().forEach((track) => track.stop());
				return;
			}
			mediaStreamRef.current = stream;

			const peerConnection = new RTCPeerConnection();
			peerConnectionRef.current = peerConnection;
			stream.getTracks().forEach((track) => peerConnection.addTrack(track, stream));
			peerConnection.ontrack = (event) => {
				const remoteStream = event.streams[0];
				if (!remoteStream) return;
				const audio = document.createElement("audio");
				audio.autoplay = true;
				audio.hidden = true;
				audio.srcObject = remoteStream;
				document.body.append(audio);
				audioRef.current?.remove();
				audioRef.current = audio;
			};

			const dataChannel = peerConnection.createDataChannel("oai-events");
			dataChannel.onmessage = (message) => {
				const data =
					typeof message.data === "string"
						? message.data
						: new TextDecoder().decode(message.data as ArrayBuffer);
				let event: RealtimeEvent;
				try {
					event = JSON.parse(data) as RealtimeEvent;
				} catch {
					return;
				}
				if (event.type === "response.audio_transcript.delta" && event.delta) {
					assistantTranscriptRef.current += event.delta;
					setAssistantTranscript(assistantTranscriptRef.current);
				} else if (
					event.type === "conversation.item.input_audio_transcription.delta" &&
					event.delta
				) {
					userTranscriptRef.current += event.delta;
					setUserTranscript(userTranscriptRef.current);
				} else if (event.type === "conversation.item.created" && event.item?.role === "assistant" && event.item.id) {
					assistantItemIdRef.current = event.item.id;
				} else if (event.type === "input_audio_buffer.speech_started") {
					if (assistantItemIdRef.current && audioRef.current) {
						const audio_end_ms = Math.floor(audioRef.current.currentTime * 1000);
						dataChannel.send(
							JSON.stringify({
								type: "conversation.item.truncate",
								item_id: assistantItemIdRef.current,
								content_index: 0,
								audio_end_ms,
							})
						);
						assistantItemIdRef.current = null;
					}
				} else if (event.type === "response.done") {
					const userText = userTranscriptRef.current;
					const assistantText = assistantTranscriptRef.current;
					if (userText || assistantText) {
						clearTranscripts();
						onTurnCompleteRef.current?.(userText, assistantText);
					}
				} else if (event.type === "error") {
					setError(new Error(event.error?.message ?? "Realtime connection failed"));
				}
			};

			const offer = await peerConnection.createOffer();
			await peerConnection.setLocalDescription(offer);
			const answerResponse = await fetch(tokenData.realtimeUrl || "https://api.openai.com/v1/realtime/calls", {
				method: "POST",
				headers: {
					Authorization: `Bearer ${ephemeralToken}`,
					"Content-Type": "application/sdp",
				},
				body: offer.sdp,
			});
			if (!answerResponse.ok) {
				const errText = await answerResponse.text();
				throw new Error(`Realtime connection failed: ${errText}`);
			}
			const answer = await answerResponse.text();
			if (!isCurrentSession()) return;
			await peerConnection.setRemoteDescription({ type: "answer", sdp: answer });
			if (isCurrentSession()) setStatus("active");
		} catch (caught) {
			if (!isCurrentSession() || (caught instanceof DOMException && caught.name === "AbortError")) {
				return;
			}
			setError(caught instanceof Error ? caught : new Error("Realtime connection failed"));
			stop();
		}
	}, [clearTranscripts, cleanupConnection, conversationId, status, stop]);

	useEffect(() => {
		return () => {
			if (disconnectTimerRef.current) clearTimeout(disconnectTimerRef.current);
			cleanupConnection();
		};
	}, [cleanupConnection]);

	return { status, error, userTranscript, assistantTranscript, start, stop };
}