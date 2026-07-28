import type {
	AssistantMessage,
	StopReason,
	Usage,
	UserMessage,
} from "@earendil-works/pi-ai";
import type {
	ChatV2Repository,
	CompleteVoiceTurnResult,
} from "./db/repository";
import type { VoiceMetadata } from "./types";
import { zeroUsage } from "./validation";

export interface VoiceTranscriptTurnInput {
	userId: string;
	conversationId: string;
	turnKey: string;
	userTranscript: string;
	assistantTranscript: string;
	provider: AssistantMessage["provider"];
	api: AssistantMessage["api"];
	model: string;
	timestamp: number;
	assistantTimestamp?: number;
	usage?: Usage;
	stopReason?: StopReason;
	metadata?: VoiceMetadata;
	audioAttachmentId?: string;
	userMessageId?: string;
	assistantMessageId?: string;
	userTurnId?: string;
	assistantTurnId?: string;
	generationId?: string;
}

export interface VoiceTranscriptTurnResult extends CompleteVoiceTurnResult {
	userMessageId: string;
	assistantMessageId: string;
}

export function voiceUserMessage(
	transcript: string,
	timestamp: number,
): UserMessage {
	return {
		role: "user",
		content: [{ type: "text", text: transcript }],
		timestamp,
	};
}

export function voiceAssistantMessage(
	transcript: string,
	input: Pick<
		VoiceTranscriptTurnInput,
		"provider" | "api" | "model" | "usage" | "stopReason"
	> & { timestamp: number },
): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text: transcript }],
		provider: input.provider,
		api: input.api,
		model: input.model,
		usage: input.usage ?? zeroUsage(),
		stopReason: input.stopReason ?? "stop",
		timestamp: input.timestamp,
	};
}

function validateVoiceMetadata(metadata: VoiceMetadata): VoiceMetadata {
	for (const key of ["interrupted", "truncated"] as const)
		if (metadata[key] !== undefined && typeof metadata[key] !== "boolean")
			throw new Error(`voice metadata ${key} must be a boolean`);
	if (
		metadata.interruptionReason !== undefined &&
		typeof metadata.interruptionReason !== "string"
	)
		throw new Error("voice metadata interruptionReason must be a string");
	return metadata;
}

/** Isolated realtime adapter that stores transcript turns through canonical M2/M4 paths. */
export class VoiceHistoryService {
	constructor(private readonly repository: ChatV2Repository) {}

	async completeTranscriptTurn(
		input: VoiceTranscriptTurnInput,
	): Promise<VoiceTranscriptTurnResult> {
		const metadata = validateVoiceMetadata(input.metadata ?? {});
		const userMessage = voiceUserMessage(input.userTranscript, input.timestamp);
		const assistantMessage = voiceAssistantMessage(input.assistantTranscript, {
			provider: input.provider,
			api: input.api,
			model: input.model,
			usage: input.usage,
			stopReason: input.stopReason,
			timestamp: input.assistantTimestamp ?? input.timestamp + 1,
		});
		const result = await this.repository.completeVoiceTurn(
			input.userId,
			input.conversationId,
			{
				turnKey: input.turnKey,
				userTurnId: input.userTurnId,
				assistantTurnId: input.assistantTurnId,
				generationId: input.generationId,
				userMessage: {
					id: input.userMessageId,
					message: userMessage,
					origin: "voice",
					status: "complete",
				},
				assistantMessage: {
					id: input.assistantMessageId,
					message: assistantMessage,
					origin: "voice",
					status: "complete",
				},
				provider: input.provider,
				api: input.api,
				model: input.model,
				requestJson: JSON.stringify({
					source: "voice",
					turnKey: input.turnKey,
				}),
				usage: assistantMessage.usage,
				stopReason: assistantMessage.stopReason,
				metadata,
			},
		);
		const records = await this.repository.listCanonicalMessages(
			input.userId,
			input.conversationId,
		);
		const userRecord = records.find(
			(record) => record.turnId === result.voiceTurn.userTurnId,
		);
		const assistantRecord = records.find(
			(record) => record.turnId === result.voiceTurn.assistantTurnId,
		);
		if (!userRecord || !assistantRecord)
			throw new Error("voice turn canonical messages are missing");
		if (input.audioAttachmentId) {
			const bindings = await this.repository.listMessageAttachments(
				input.userId,
				input.conversationId,
			);
			if (
				!bindings.some(
					(binding) =>
						binding.messageId === userRecord.id &&
						binding.attachment.id === input.audioAttachmentId,
				)
			)
				await this.repository.bindAttachment(
					input.userId,
					input.conversationId,
					userRecord.id,
					input.audioAttachmentId,
					0,
				);
		}
		return {
			...result,
			userMessageId: userRecord.id,
			assistantMessageId: assistantRecord.id,
		};
	}
}
