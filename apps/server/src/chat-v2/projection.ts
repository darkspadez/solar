import type { Message } from "@earendil-works/pi-ai";
import type {
	CanonicalMessageOrigin,
	CanonicalMessageRecord,
	CanonicalMessageStatus,
	VisibleTurnRole,
} from "./types";
import type { AttachmentRecord } from "./types";

export interface VisibleAttachmentReference {
	id: string;
	filename: string;
	mimeType: string;
	kind: string;
	byteSize: number;
	storageKey: string;
}

export interface VisibleTurn {
	id: string;
	role: VisibleTurnRole;
	origin: CanonicalMessageOrigin;
	status: CanonicalMessageStatus;
	messages: CanonicalMessageRecord[];
	displayText: string;
	reasoning: string[];
	attachments: VisibleAttachmentReference[];
}

export function displayText(message: Message): string {
	if (typeof message.content === "string") return message.content;
	return message.content
		.filter((content) => content.type === "text")
		.map((content) => content.text)
		.join("\n");
}

function reasoning(message: Message): string[] {
	if (message.role !== "assistant") return [];
	return message.content
		.filter((content) => content.type === "thinking")
		.map((content) => content.thinking);
}

function turnRole(record: CanonicalMessageRecord): VisibleTurnRole {
	if (record.role === "user") return "user";
	return "assistant";
}

export function projectVisibleTurns(
	records: readonly CanonicalMessageRecord[],
	attachmentsByMessageId: ReadonlyMap<string, readonly AttachmentRecord[]> = new Map(),
): VisibleTurn[] {
	const turns: VisibleTurn[] = [];
	const seenTurnIds = new Set<string>();
	for (const record of records) {
		if (!record.turnId) throw new Error(`canonical message ${record.id} has no visible turn`);
		const role = turnRole(record);
		const current = turns.at(-1);
		if (!current || current.id !== record.turnId) {
			if (seenTurnIds.has(record.turnId))
				throw new Error(`visible turn ${record.turnId} is not contiguous`);
			seenTurnIds.add(record.turnId);
			turns.push({
				id: record.turnId,
				role,
				origin: record.origin,
				status: record.status,
				messages: [record],
				displayText: displayText(record.message),
				reasoning: reasoning(record.message),
				attachments: attachmentReferences(attachmentsByMessageId.get(record.id) ?? []),
			});
			continue;
		}
		if (current.role !== role)
			throw new Error(`visible turn ${record.turnId} mixes user and assistant messages`);
		current.messages.push(record);
		const text = displayText(record.message);
		if (text) current.displayText = [current.displayText, text].filter(Boolean).join("\n");
		current.reasoning.push(...reasoning(record.message));
		current.attachments.push(...attachmentReferences(attachmentsByMessageId.get(record.id) ?? []));
	}
	return turns;
}

function attachmentReferences(attachments: readonly AttachmentRecord[]): VisibleAttachmentReference[] {
	return attachments.map(({ id, filename, mimeType, kind, byteSize, storageKey }) => ({ id, filename, mimeType, kind, byteSize, storageKey }));
}
