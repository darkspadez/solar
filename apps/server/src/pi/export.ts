/**
 * pi → chat-v2 export bundle projection (for the history CLI / admin export).
 * Migrated conversations export from their pi session files; the resulting
 * bundle validates against ChatV2ImportService, so reimporting it produces a
 * chat-v2 archive row-set that migrates into pi on first touch.
 */
import {
	SessionManager,
	type SessionMessageEntry,
} from "@earendil-works/pi-coding-agent";
import type { Message } from "@earendil-works/pi-ai";
import {
	CHAT_V2_EXPORT_VERSION,
	type ChatV2ExportBundle,
} from "../chat-v2/export";
import { chatV2Repository } from "../chat-v2/db/repository";
import type {
	AttachmentRecord,
	CanonicalMessageRecord,
	ConversationTurnRecord,
} from "../chat-v2/types";
import { piSessionDir } from "./config";
import { piSessionFile } from "./migration";

interface MarkerEntry {
	entryId: string;
	attachmentIds: string[];
}

function messageTextOf(message: { content?: unknown }): string {
	const content = message.content;
	if (typeof content === "string") return content;
	return (
		(content as Array<{ type?: string; text?: string }> | undefined) ?? []
	)
		.filter((part) => part.type === "text")
		.map((part) => part.text ?? "")
		.join("\n");
}

/** Build one export bundle from the pi session of a migrated conversation. */
export async function buildPiExportBundle(
	userId: string,
	conversationId: string,
): Promise<ChatV2ExportBundle> {
	const file = piSessionFile(conversationId);
	if (!file) throw new Error("conversation has no pi session");
	const manager = SessionManager.open(file, piSessionDir(conversationId));
	const conversation = (await chatV2Repository.listConversations(userId)).find(
		(candidate) => candidate.id === conversationId,
	);
	if (!conversation) throw new Error("conversation not found");
	const messageEntries = manager
		.getEntries()
		.filter((entry): entry is SessionMessageEntry => entry.type === "message");

	const markers: MarkerEntry[] = [];
	const messages: CanonicalMessageRecord[] = [];
	const turns: ConversationTurnRecord[] = [];

	let ordinal = 0;
	let turnId: string | null = null;
	let turnRole: "user" | "assistant" | null = null;
	for (const entry of messageEntries) {
		const role = entry.message.role === "user" ? "user" : "assistant";
		const turnStart = turnId === null || role !== turnRole;
		if (turnStart) {
			turnId = entry.id;
			turnRole = role;
			turns.push({
				id: entry.id,
				conversationId,
				ordinal: turns.length,
				role,
				origin: "text",
				status: "complete",
				createdAt: entry.timestamp,
			});
		}
		messages.push({
			id: entry.id,
			conversationId,
			turnId,
			ordinal: ordinal++,
			role: entry.message.role as CanonicalMessageRecord["role"],
			// AgentMessage (pi 0.84) → Message (Solar's pi-ai 0.80 import site):
			// structurally a superset for every role we emit here.
			message: entry.message as unknown as never,
			origin: "text",
			status: "complete",
			createdAt: entry.timestamp,
		});
		if (role === "user") {
			const ids = [
				...(messageTextOf(
					entry.message as unknown as { content?: unknown },
				).matchAll(/<solar-attachments\s+ids="([^"]*)"\s*\/>/g) ?? []),
			].flatMap((match) => (match[1] ?? "").split(",").filter(Boolean));
			if (ids.length) markers.push({ entryId: entry.id, attachmentIds: ids });
		}
	}

	const attachmentIds = [...new Set(markers.flatMap((m) => m.attachmentIds))];
	const attachments: AttachmentRecord[] = [];
	for (const id of attachmentIds) {
		const attachment = await chatV2Repository
			.getAttachment(userId, id)
			.catch(() => null);
		if (attachment) attachments.push(attachment);
	}
	const bindings = markers.flatMap(({ entryId, attachmentIds }) =>
		attachmentIds
			.filter((id) => attachments.some((a) => a.id === id))
			.map((attachmentId, index) => ({
				messageId: entryId,
				attachmentId,
				ordinal: index,
			})),
	);

	return {
		version: CHAT_V2_EXPORT_VERSION,
		sourceUserId: userId,
		conversation: {
			id: conversation.id,
			userId: conversation.userId,
			title:
				manager.getSessionName() ??
				conversation.title ??
				`Imported ${conversationId}`,
			folderId: conversation.folderId,
			provider: conversation.provider,
			endpointId: conversation.endpointId,
			modelId: conversation.modelId,
			modelApi: conversation.modelApi,
			systemPrompt: conversation.systemPrompt,
			generationConfig: {},
			createdAt: conversation.createdAt,
			updatedAt: conversation.updatedAt,
		},
		turns,
		messages,
		attachments,
		bindings,
		generations: [],
		generationEvents: [],
		folder: conversation.folderId
			? ((await chatV2Repository.listFolders(userId)).find(
					(folder) => folder.id === conversation.folderId,
				) ?? null)
			: null,
		tags: (await chatV2Repository.listTags(userId)).filter((tag) =>
			conversation.tagIds.includes(tag.id),
		),
		voiceTurns: [],
	};
}
