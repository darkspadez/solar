import type { Message, StopReason, Usage } from "@earendil-works/pi-ai";
import type { Kysely } from "kysely";
import type { Database } from "../db/schema";
import type { ChatV2Repository } from "./db/repository";
import type {
	AttachmentRecord,
	CanonicalMessageOrigin,
	CanonicalMessageStatus,
	CanonicalMessageRecord,
	ContextCompactionRecord,
	ContextManifest,
	ConversationRecord,
	ConversationTurnRecord,
	VoiceMetadata,
} from "./types";

export const CHAT_V2_EXPORT_VERSION = 2 as const;

export interface ExportGeneration {
	id: string;
	conversationId: string;
	turnId: string | null;
	status: string;
	provider: string;
	api: string;
	model: string;
	request: Record<string, unknown>;
	contextManifest: ContextManifest | null;
	partialMessage: Message | null;
	usage: Usage | null;
	stopReason: StopReason | null;
	errorMessage: string | null;
	startedAt: string | null;
	finishedAt: string | null;
	createdAt: string;
}

export interface ExportVoiceTurn {
	turnKey: string;
	conversationId: string;
	userTurnId: string;
	assistantTurnId: string;
	generationId: string;
	metadata: VoiceMetadata;
	createdAt: string;
}

export interface ChatV2ExportBundle {
	version: typeof CHAT_V2_EXPORT_VERSION;
	sourceUserId: string;
	conversation: ConversationRecord;
	turns: ConversationTurnRecord[];
	messages: CanonicalMessageRecord[];
	attachments: AttachmentRecord[];
	bindings: Array<{ messageId: string; attachmentId: string; ordinal: number }>;
	generations: ExportGeneration[];
	generationEvents: Array<{
		generationId: string;
		sequence: number;
		kind: string;
		payload: Record<string, unknown>;
		createdAt: string;
	}>;
	compactions?: ContextCompactionRecord[];
	folder: { id: string; name: string; createdAt: string } | null;
	tags: Array<{ id: string; name: string; createdAt: string }>;
	voiceTurns: ExportVoiceTurn[];
}

function parseJson<T>(value: string | null): T | null {
	return value === null ? null : (JSON.parse(value) as T);
}

/** Builds a JSON-serializable, metadata-only bundle for one owned v2 conversation. */
export class ChatV2ExportService {
	constructor(
		private readonly db: Kysely<Database>,
		private readonly repository: ChatV2Repository,
	) {}

	async build(
		userId: string,
		conversationId: string,
		options: { includeCompactions?: boolean } = {},
	): Promise<ChatV2ExportBundle> {
		const conversation = await this.repository.getConversation(
			userId,
			conversationId,
		);
		const [
			messages,
			turns,
			attachmentRows,
			generations,
			generationEvents,
			voiceRows,
		] = await Promise.all([
			this.repository.listCanonicalMessages(userId, conversationId),
			this.db
				.selectFrom("v2_conversation_turn")
				.selectAll()
				.where("conversationId", "=", conversationId)
				.orderBy("ordinal")
				.execute(),
			this.db
				.selectFrom("v2_message_attachment as binding")
				.innerJoin(
					"v2_conversation_message as message",
					"message.id",
					"binding.messageId",
				)
				.innerJoin(
					"v2_attachment as attachment",
					"attachment.id",
					"binding.attachmentId",
				)
				.select([
					"binding.messageId",
					"binding.attachmentId",
					"binding.ordinal",
					"attachment.id",
					"attachment.userId",
					"attachment.storageKey",
					"attachment.filename",
					"attachment.mimeType",
					"attachment.kind",
					"attachment.byteSize",
					"attachment.sha256",
					"attachment.width",
					"attachment.height",
					"attachment.pageCount",
					"attachment.createdAt",
				])
				.where("message.conversationId", "=", conversationId)
				.orderBy("binding.messageId")
				.orderBy("binding.ordinal")
				.execute(),
			this.db
				.selectFrom("v2_generation")
				.selectAll()
				.where("conversationId", "=", conversationId)
				.orderBy("createdAt")
				.execute(),
			this.db
				.selectFrom("v2_generation_event as event")
				.innerJoin(
					"v2_generation as generation",
					"generation.id",
					"event.generationId",
				)
				.selectAll("event")
				.where("generation.conversationId", "=", conversationId)
				.orderBy("event.generationId")
				.orderBy("event.sequence")
				.execute(),
			this.db
				.selectFrom("v2_voice_turn")
				.selectAll()
				.where("conversationId", "=", conversationId)
				.orderBy("createdAt")
				.execute(),
		]);
		const attachmentById = new Map<string, AttachmentRecord>();
		for (const row of attachmentRows) {
			const {
				messageId: _messageId,
				attachmentId: _attachmentId,
				ordinal: _ordinal,
				...attachment
			} = row;
			attachmentById.set(attachment.id, attachment);
		}
		const folder = conversation.folderId
			? ((await this.db
					.selectFrom("v2_folder")
					.select(["id", "name", "createdAt"])
					.where("id", "=", conversation.folderId)
					.where("userId", "=", userId)
					.executeTakeFirst()) ?? null)
			: null;
		const tags = await this.db
			.selectFrom("v2_conversation_tag as binding")
			.innerJoin("v2_tag as tag", "tag.id", "binding.tagId")
			.select(["tag.id", "tag.name", "tag.createdAt"])
			.where("binding.conversationId", "=", conversationId)
			.where("tag.userId", "=", userId)
			.orderBy("tag.id")
			.execute();
		return {
			version: CHAT_V2_EXPORT_VERSION,
			sourceUserId: userId,
			conversation: {
				...conversation,
				generationConfig: JSON.parse(
					conversation.generationConfigJson,
				) as Record<string, unknown>,
			},
			turns: turns.map((turn) => ({
				...turn,
				origin: turn.origin as CanonicalMessageOrigin,
				status: turn.status as CanonicalMessageStatus,
			})),
			messages,
			attachments: [...attachmentById.values()],
			bindings: attachmentRows.map(({ messageId, attachmentId, ordinal }) => ({
				messageId,
				attachmentId,
				ordinal,
			})),
			generations: generations.map((generation) => ({
				...generation,
				request: JSON.parse(generation.requestJson) as Record<string, unknown>,
				contextManifest: parseJson<ContextManifest>(
					generation.contextManifestJson,
				),
				partialMessage: parseJson<Message>(generation.partialMessageJson),
				usage: parseJson<Usage>(generation.usageJson),
				stopReason: generation.stopReason as StopReason | null,
			})),
			generationEvents: generationEvents.map((event) => ({
				...event,
				payload: JSON.parse(event.payloadJson) as Record<string, unknown>,
			})),
			compactions:
				options.includeCompactions === false
					? undefined
					: await this.repository.listCompactions(userId, conversationId),
			folder,
			tags,
			voiceTurns: voiceRows.map(({ metadataJson, ...voice }) => ({
				...voice,
				metadata: JSON.parse(metadataJson) as VoiceMetadata,
			})),
		};
	}
}
