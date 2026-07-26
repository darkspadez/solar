import { useCallback, useEffect, useRef, useState } from "react";

export type OpenAIRealtimeStatus = "disconnected" | "connecting" | "active";
export type OpenAIRealtimeActivity =
	| "idle"
	| "connecting"
	| "listening"
	| "user-speaking"
	| "assistant-speaking";

export interface UseOpenAIRealtimeResult {
	status: OpenAIRealtimeStatus;
	activity: OpenAIRealtimeActivity;
	error: Error | null;
	userTranscript: string;
	assistantTranscript: string;
	start: () => Promise<void>;
	stop: () => void;
}

interface RealtimeEvent {
	type?: string;
	event_id?: string;
	item_id?: string;
	delta?: string;
	transcript?: string;
	error?: { message?: string };
	item?: { id?: string; role?: string };
	response?: { id?: string; status?: string };
}

interface RealtimeTokenResponse {
	value?: string;
	client_secret?: { value?: string };
	realtimeUrl?: string;
	history?: Array<{ role: "user" | "assistant"; text: string }>;
}

export function useOpenAIRealtime(
	conversationId: string,
	onTurnComplete?: (
		userText: string,
		assistantText: string,
	) => void | Promise<void>,
): UseOpenAIRealtimeResult {
	const [status, setStatus] = useState<OpenAIRealtimeStatus>("disconnected");
	const [activity, setActivity] = useState<OpenAIRealtimeActivity>("idle");
	const [error, setError] = useState<Error | null>(null);
	const [userTranscript, setUserTranscript] = useState("");
	const [assistantTranscript, setAssistantTranscript] = useState("");

	const peerConnectionRef = useRef<RTCPeerConnection | null>(null);
	const mediaStreamRef = useRef<MediaStream | null>(null);
	const audioRef = useRef<HTMLAudioElement | null>(null);
	const tokenRequestRef = useRef<AbortController | null>(null);

	const userTranscriptRef = useRef("");
	const assistantTranscriptRef = useRef("");
	const responseDoneRef = useRef(false);
	const displayGenerationRef = useRef(0);
	const assistantItemIdRef = useRef<string | null>(null);
	const onTurnCompleteRef = useRef(onTurnComplete);
	const sessionIdRef = useRef(0);
	const eventSequenceRef = useRef(0);
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

	const completeTurn = useCallback(() => {
		const userText = userTranscriptRef.current.trim();
		const assistantText = assistantTranscriptRef.current.trim();
		console.info("[voice/realtime] turn completion check", {
			sessionId: sessionIdRef.current,
			responseDone: responseDoneRef.current,
			userChars: userText.length,
			assistantChars: assistantText.length,
		});
		if (!responseDoneRef.current || !userText || !assistantText) return;

		const displayGeneration = displayGenerationRef.current;
		userTranscriptRef.current = "";
		assistantTranscriptRef.current = "";
		responseDoneRef.current = false;
		console.info("[voice/realtime] persisting completed turn", {
			sessionId: sessionIdRef.current,
			userChars: userText.length,
			assistantChars: assistantText.length,
		});
		void Promise.resolve(onTurnCompleteRef.current?.(userText, assistantText))
			.then(() => {
				console.info("[voice/realtime] completed turn persisted", {
					sessionId: sessionIdRef.current,
				});
			})
			.catch((caught) => {
				console.error("[voice/realtime] completed turn persistence failed", {
					sessionId: sessionIdRef.current,
					error: caught instanceof Error ? caught.message : String(caught),
				});
				setError(
					caught instanceof Error
						? caught
						: new Error("Could not save the voice turn"),
				);
			})
			.finally(() => {
				if (displayGenerationRef.current === displayGeneration) {
					setUserTranscript("");
					setAssistantTranscript("");
					setActivity("listening");
				}
			});
	}, []);

	const cleanupConnection = useCallback(() => {
		console.info("[voice/realtime] cleaning up connection", {
			sessionId: sessionIdRef.current,
		});
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
		console.info("[voice/realtime] stopping session", {
			sessionId: sessionIdRef.current,
		});
		// Immediately update UI
		setStatus("disconnected");
		setActivity("idle");

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
		eventSequenceRef.current = 0;
		console.info("[voice/realtime] starting session", {
			sessionId,
			conversationId,
		});
		if (disconnectTimerRef.current) {
			clearTimeout(disconnectTimerRef.current);
			disconnectTimerRef.current = null;
		}

		// If there is an existing connection, clean it up before starting a new one
		cleanupConnection();

		const isCurrentSession = () => sessionIdRef.current === sessionId;
		setStatus("connecting");
		setActivity("connecting");
		setError(null);
		clearTranscripts();

		try {
			const tokenRequest = new AbortController();
			tokenRequestRef.current = tokenRequest;
			const tokenResponse = await fetch(
				`/api/chat/realtime-token?${new URLSearchParams({ conversationId })}`,
				{ signal: tokenRequest.signal },
			);
			console.info("[voice/realtime] token request completed", {
				sessionId,
				status: tokenResponse.status,
			});
			if (!tokenResponse.ok) {
				const errText = await tokenResponse.text();
				throw new Error(`Realtime token request failed: ${errText}`);
			}
			const tokenData = (await tokenResponse.json()) as RealtimeTokenResponse;
			const ephemeralToken = tokenData.value ?? tokenData.client_secret?.value;
			if (!ephemeralToken)
				throw new Error("Realtime token response was invalid");
			if (!isCurrentSession()) return;

			const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
			console.info("[voice/realtime] microphone acquired", { sessionId });
			if (!isCurrentSession()) {
				stream.getTracks().forEach((track) => track.stop());
				return;
			}
			mediaStreamRef.current = stream;
			stream.getAudioTracks().forEach((track) => {
				track.enabled = false;
			});

			const peerConnection = new RTCPeerConnection();
			peerConnectionRef.current = peerConnection;
			stream
				.getTracks()
				.forEach((track) => peerConnection.addTrack(track, stream));
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
			let pendingHistoryItems = 0;
			const activateSession = () => {
				if (!isCurrentSession()) return;
				stream.getAudioTracks().forEach((track) => {
					track.enabled = true;
				});
				setStatus("active");
				setActivity("listening");
				console.info("[voice/realtime] session active", { sessionId });
			};
			dataChannel.onopen = () => {
				if (!isCurrentSession()) return;
				const history = tokenData.history ?? [];
				pendingHistoryItems = history.length;
				for (const message of history) {
					dataChannel.send(
						JSON.stringify({
							type: "conversation.item.create",
							item: {
								type: "message",
								role: message.role,
								content: [
									{
										type:
											message.role === "assistant"
												? "output_text"
												: "input_text",
										text: message.text,
									},
								],
							},
						}),
					);
				}
				console.info("[voice/realtime] history seeded", {
					sessionId,
					messages: history.length,
				});
				if (pendingHistoryItems === 0) activateSession();
			};
			dataChannel.onmessage = (message) => {
				const data =
					typeof message.data === "string"
						? message.data
						: new TextDecoder().decode(message.data as ArrayBuffer);
				let event: RealtimeEvent;
				try {
					event = JSON.parse(data) as RealtimeEvent;
				} catch {
					console.warn("[voice/realtime] ignored non-JSON event", {
						sessionId,
					});
					return;
				}
				const sequence = ++eventSequenceRef.current;
				if (event.type !== "response.output_audio.delta") {
					console.info("[voice/realtime] server event", {
						sessionId,
						sequence,
						type: event.type,
						eventId: event.event_id,
						itemId: event.item_id ?? event.item?.id,
						responseId: event.response?.id,
						responseStatus: event.response?.status,
						deltaChars: event.delta?.length ?? 0,
						transcriptChars: event.transcript?.length ?? 0,
						userChars: userTranscriptRef.current.length,
						assistantChars: assistantTranscriptRef.current.length,
						responseDone: responseDoneRef.current,
					});
				}
				if (
					pendingHistoryItems > 0 &&
					(event.type === "conversation.item.added" ||
						event.type === "conversation.item.created")
				) {
					pendingHistoryItems -= 1;
					console.info("[voice/realtime] history item acknowledged", {
						sessionId,
						remaining: pendingHistoryItems,
					});
					if (pendingHistoryItems === 0) activateSession();
					return;
				}
				if (
					(event.type === "response.output_audio_transcript.delta" ||
						event.type === "response.audio_transcript.delta") &&
					event.delta
				) {
					assistantTranscriptRef.current += event.delta;
					setAssistantTranscript(assistantTranscriptRef.current);
					setActivity("assistant-speaking");
				} else if (
					(event.type === "response.output_audio_transcript.done" ||
						event.type === "response.audio_transcript.done") &&
					event.transcript
				) {
					assistantTranscriptRef.current = event.transcript;
					setAssistantTranscript(event.transcript);
					completeTurn();
				} else if (
					event.type === "conversation.item.input_audio_transcription.delta" &&
					event.delta
				) {
					userTranscriptRef.current += event.delta;
					setUserTranscript(userTranscriptRef.current);
				} else if (
					event.type ===
						"conversation.item.input_audio_transcription.completed" &&
					event.transcript
				) {
					userTranscriptRef.current = event.transcript;
					setUserTranscript(event.transcript);
					completeTurn();
				} else if (
					event.type === "conversation.item.created" &&
					event.item?.role === "assistant" &&
					event.item.id
				) {
					assistantItemIdRef.current = event.item.id;
				} else if (event.type === "input_audio_buffer.speech_started") {
					if (responseDoneRef.current) {
						userTranscriptRef.current = "";
						assistantTranscriptRef.current = "";
						responseDoneRef.current = false;
					}
					displayGenerationRef.current += 1;
					setUserTranscript("");
					setAssistantTranscript("");
					setActivity("user-speaking");
					if (assistantItemIdRef.current && audioRef.current) {
						const audio_end_ms = Math.floor(
							audioRef.current.currentTime * 1000,
						);
						dataChannel.send(
							JSON.stringify({
								type: "conversation.item.truncate",
								item_id: assistantItemIdRef.current,
								content_index: 0,
								audio_end_ms,
							}),
						);
						assistantItemIdRef.current = null;
					}
				} else if (event.type === "input_audio_buffer.speech_stopped") {
					setActivity("assistant-speaking");
				} else if (event.type === "response.done") {
					if (event.response?.status && event.response.status !== "completed") {
						console.info("[voice/realtime] ignored non-completed response", {
							sessionId,
							responseId: event.response.id,
							status: event.response.status,
						});
						return;
					}
					responseDoneRef.current = true;
					completeTurn();
				} else if (event.type === "error") {
					setError(
						new Error(event.error?.message ?? "Realtime connection failed"),
					);
					stop();
				}
			};

			const offer = await peerConnection.createOffer();
			await peerConnection.setLocalDescription(offer);
			const answerResponse = await fetch(
				tokenData.realtimeUrl || "https://api.openai.com/v1/realtime/calls",
				{
					method: "POST",
					headers: {
						Authorization: `Bearer ${ephemeralToken}`,
						"Content-Type": "application/sdp",
					},
					body: offer.sdp,
				},
			);
			console.info("[voice/realtime] SDP request completed", {
				sessionId,
				status: answerResponse.status,
			});
			if (!answerResponse.ok) {
				const errText = await answerResponse.text();
				throw new Error(`Realtime connection failed: ${errText}`);
			}
			const answer = await answerResponse.text();
			if (!isCurrentSession()) return;
			await peerConnection.setRemoteDescription({
				type: "answer",
				sdp: answer,
			});
		} catch (caught) {
			if (
				!isCurrentSession() ||
				(caught instanceof DOMException && caught.name === "AbortError")
			) {
				return;
			}
			setError(
				caught instanceof Error
					? caught
					: new Error("Realtime connection failed"),
			);
			console.error("[voice/realtime] session failed", {
				sessionId,
				error: caught instanceof Error ? caught.message : String(caught),
			});
			stop();
		}
	}, [
		clearTranscripts,
		cleanupConnection,
		completeTurn,
		conversationId,
		status,
		stop,
	]);

	useEffect(() => {
		return () => {
			if (disconnectTimerRef.current) clearTimeout(disconnectTimerRef.current);
			cleanupConnection();
		};
	}, [cleanupConnection]);

	return {
		status,
		activity,
		error,
		userTranscript,
		assistantTranscript,
		start,
		stop,
	};
}
