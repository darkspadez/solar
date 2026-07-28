import type { Message } from "@earendil-works/pi-ai";
import type {
	CanonicalMessageOrigin,
	CanonicalMessageStatus,
} from "./types";
import type {
	ChatV2Repository,
	CreateGenerationInput,
	SuffixReplacementResult,
} from "./db/repository";

export interface NewGenerationInput {
	id?: string;
	provider: string;
	api: string;
	model: string;
	request: Record<string, unknown>;
	status?: "queued" | "running";
}

export interface EditUserMessageCommand {
	userId: string;
	conversationId: string;
	targetTurnId: string;
	message: Message;
	origin?: CanonicalMessageOrigin;
	status?: CanonicalMessageStatus;
	userTurnId?: string;
	assistantTurnId?: string;
	generation: NewGenerationInput;
}

export interface RegenerateAssistantTurnCommand {
	userId: string;
	conversationId: string;
	targetTurnId: string;
	assistantTurnId?: string;
	generation: NewGenerationInput;
}

export type OrphanedAttachmentCleanup = (attachmentIds: readonly string[]) => Promise<void> | void;

function generationInput(input: NewGenerationInput): Omit<CreateGenerationInput, "turnId"> {
	return {
		id: input.id,
		status: input.status ?? "running",
		provider: input.provider,
		api: input.api,
		model: input.model,
		requestJson: JSON.stringify(input.request),
	};
}

/** M5 commands keep destructive replacement and generation creation in one repository transaction. */
export class ChatV2EditService {
	constructor(
		private readonly repository: ChatV2Repository,
		private readonly cleanupOrphanedAttachments?: OrphanedAttachmentCleanup,
	) {}

	async editUserMessage(input: EditUserMessageCommand): Promise<SuffixReplacementResult> {
		const result = await this.repository.editUserMessage(
			input.userId,
			input.conversationId,
			input.targetTurnId,
			{
				replacement: {
					message: input.message,
					origin: input.origin ?? "text",
					status: input.status ?? "complete",
				},
				userTurnId: input.userTurnId,
				assistantTurnId: input.assistantTurnId,
				generation: generationInput(input.generation),
			},
		);
		await this.cleanup(result.orphanedAttachmentIds);
		return result;
	}

	async regenerateAssistantTurn(
		input: RegenerateAssistantTurnCommand,
	): Promise<SuffixReplacementResult> {
		const result = await this.repository.regenerateAssistantTurn(
			input.userId,
			input.conversationId,
			input.targetTurnId,
			{
				assistantTurnId: input.assistantTurnId,
				generation: generationInput(input.generation),
			},
		);
		await this.cleanup(result.orphanedAttachmentIds);
		return result;
	}

	private async cleanup(attachmentIds: readonly string[]): Promise<void> {
		if (attachmentIds.length > 0) await this.cleanupOrphanedAttachments?.(attachmentIds);
	}
}
