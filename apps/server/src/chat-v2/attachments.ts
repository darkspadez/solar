import type { Message } from "@earendil-works/pi-ai";
import type { ChatV2Repository, CreateAttachmentInput } from "./db/repository";
import type { AttachmentDecision, AttachmentRecord, CanonicalMessageRecord } from "./types";

export interface AttachmentCapabilities {
	supportsImages: boolean;
	maxAttachmentBytes?: number;
}

export type ResolvedAttachment =
	| { type: "image"; data: string }
	| { type: "text"; text: string; summarized?: boolean };

export type AttachmentResolver = (attachment: AttachmentRecord) => ResolvedAttachment | null;

export interface AttachmentExpansionInput {
	attachmentsByMessageId: ReadonlyMap<string, readonly AttachmentRecord[]>;
	capabilities: AttachmentCapabilities;
	resolve: AttachmentResolver;
}

export interface ExpandedMessage {
	message: Message;
	decisions: AttachmentDecision[];
}

/** Expands relational attachment metadata only in the outbound copy of a message. */
export function expandMessageAttachments(
	record: CanonicalMessageRecord,
	attachments: readonly AttachmentRecord[],
	capabilities: AttachmentCapabilities,
	resolve: AttachmentResolver,
): ExpandedMessage {
	if (attachments.length === 0) return { message: record.message, decisions: [] };
	const decisions: AttachmentDecision[] = [];
	if (record.message.role === "assistant")
		return {
			message: record.message,
			decisions: attachments.map((attachment) => ({ messageId: record.id, attachmentId: attachment.id, decision: "unsupported_by_model" })),
		};
	const content = typeof record.message.content === "string"
		? [{ type: "text" as const, text: record.message.content }]
		: [...record.message.content];
	let expanded = false;
	for (const attachment of attachments) {
		if (capabilities.maxAttachmentBytes !== undefined && attachment.byteSize > capabilities.maxAttachmentBytes) {
			decisions.push({ messageId: record.id, attachmentId: attachment.id, decision: "omitted_by_budget" });
			continue;
		}
		if (attachment.kind === "image" && !capabilities.supportsImages) {
			decisions.push({ messageId: record.id, attachmentId: attachment.id, decision: "unsupported_by_model" });
			continue;
		}
		const resolved = resolve(attachment);
		if (!resolved) {
			decisions.push({ messageId: record.id, attachmentId: attachment.id, decision: "unavailable" });
			continue;
		}
		if (resolved.type === "image") {
			if (!capabilities.supportsImages) {
				decisions.push({ messageId: record.id, attachmentId: attachment.id, decision: "unsupported_by_model" });
				continue;
			}
			content.push({ type: "image", data: resolved.data, mimeType: attachment.mimeType });
		} else content.push({ type: "text", text: resolved.text });
		expanded = true;
		decisions.push({ messageId: record.id, attachmentId: attachment.id, decision: resolved.type === "text" && resolved.summarized ? "summarized" : "included" });
	}
	return { message: expanded ? ({ ...record.message, content } as Message) : record.message, decisions };
}

export class AttachmentService {
	constructor(private readonly repository: ChatV2Repository) {}

	create(userId: string, input: CreateAttachmentInput): Promise<AttachmentRecord> {
		return this.repository.createAttachment(userId, input);
	}

	bind(userId: string, conversationId: string, messageId: string, attachmentId: string, ordinal: number): Promise<void> {
		return this.repository.bindAttachment(userId, conversationId, messageId, attachmentId, ordinal);
	}
}
