import type { Message, StopReason, Usage } from "@earendil-works/pi-ai";
import type { Kysely, Transaction } from "kysely";
import type { Database } from "../../db/schema";
import {
	CANONICAL_MESSAGE_ORIGINS,
	CANONICAL_MESSAGE_STATUSES,
	type CanonicalMessageRecord,
	type CanonicalMessageOrigin,
	type CanonicalMessageStatus,
	type AttachmentRecord,
	type ConversationListRecord,
	type ContextCompactionJobRecord,
	type ContextCompactionRecord,
	type ContextManifest,
	type GenerationStatus,
	type VisibleTurnRole,
	type VoiceMetadata,
	type VoiceTurnRecord,
} from "../types";
import {
	CanonicalMessageValidationError,
	parseCanonicalMessage,
	validateMessageSequence,
} from "../validation";
import { assertSafeCompactionRange, sourceHash } from "../context";
import { logger } from "../../logger";

type Executor = Kysely<Database> | Transaction<Database>;

export class V2NotFoundError extends Error {
	constructor(resource: string, id: string) {
		super(`${resource} ${id} was not found for this user`);
		this.name = "V2NotFoundError";
	}
}

export class V2StaleTargetError extends Error {
	constructor(resource: "turn", id: string) {
		super(
			`${resource} ${id} is no longer part of the live conversation history`,
		);
		this.name = "V2StaleTargetError";
	}
}

export interface CreateConversationInput {
	id?: string;
	title: string;
	folderId?: string | null;
	provider?: string | null;
	endpointId?: string | null;
	modelId?: string | null;
	modelApi?: string | null;
	systemPrompt?: string | null;
	reasoningEffort?: string | null;
	reasoningSummary?: boolean;
	verbosity?: string | null;
	displayMode?: string | null;
	generationConfigJson?: string;
	createdAt?: string;
}

export interface CreateAttachmentInput {
	id?: string;
	storageKey: string;
	filename: string;
	mimeType: string;
	kind: string;
	byteSize: number;
	sha256: string;
	width?: number | null;
	height?: number | null;
	pageCount?: number | null;
	createdAt?: string;
}

export interface CreateOrganizationInput {
	id?: string;
	name: string;
	createdAt?: string;
}

export interface CreateTurnInput {
	id?: string;
	ordinal: number;
	role: VisibleTurnRole;
	origin: CanonicalMessageOrigin;
	status: CanonicalMessageStatus;
	createdAt?: string;
}

export interface CanonicalMessageInput {
	id?: string;
	turnId?: string | null;
	message: Message;
	origin: CanonicalMessageOrigin;
	status: CanonicalMessageStatus;
	createdAt?: string;
}

export interface CreateGenerationInput {
	id?: string;
	turnId?: string | null;
	status: GenerationStatus;
	provider: string;
	api: string;
	model: string;
	requestJson: string;
	createdAt?: string;
}

export interface GenerationCheckpointInput {
	message: Message;
	createdAt?: string;
}

export interface FinalizeGenerationInput {
	messages: readonly CanonicalMessageInput[];
	status: "complete" | "stopped" | "error";
	usage?: Usage;
	stopReason?: StopReason;
	errorMessage?: string;
	finishedAt?: string;
}

export interface CompleteVoiceTurnInput {
	turnKey: string;
	userTurnId?: string;
	assistantTurnId?: string;
	generationId?: string;
	userMessage: CanonicalMessageInput;
	assistantMessage: CanonicalMessageInput;
	provider: string;
	api: string;
	model: string;
	requestJson: string;
	usage: Usage;
	stopReason: StopReason;
	metadata: VoiceMetadata;
}

export interface CompleteVoiceTurnResult {
	voiceTurn: VoiceTurnRecord;
	created: boolean;
}

export interface EnqueueCompactionJobInput {
	firstMessageId: string;
	lastMessageId: string;
	sourceHash: string;
}

export interface MaterializeCompactionJobInput {
	id?: string;
	replacementMessages: readonly Message[];
	promptVersion: string;
	provider?: string | null;
	api?: string | null;
	model?: string | null;
	tokensBefore?: number | null;
	tokensAfter?: number | null;
}

export interface EditUserMessageInput {
	replacement: Omit<CanonicalMessageInput, "turnId">;
	userTurnId?: string;
	assistantTurnId?: string;
	generation: Omit<CreateGenerationInput, "turnId">;
}

export interface RegenerateAssistantTurnInput {
	assistantTurnId?: string;
	generation: Omit<CreateGenerationInput, "turnId">;
}

export interface SuffixDeletionResult {
	fromOrdinal: number;
	orphanedAttachmentIds: string[];
}

export interface SuffixReplacementResult extends SuffixDeletionResult {
	userTurnId?: string;
	assistantTurnId: string;
	generationId: string;
}

function now(): string {
	return new Date().toISOString();
}

function id(): string {
	return crypto.randomUUID();
}

function isActiveGenerationStatus(status: string): boolean {
	return status === "queued" || status === "running";
}

function requireKnownValue<T extends readonly string[]>(
	value: string,
	values: T,
	name: string,
): asserts value is T[number] {
	if (!values.includes(value)) throw new Error(`${name} is invalid`);
}

export class ChatV2Repository {
	constructor(private readonly db: Kysely<Database>) {}

	async createConversation(userId: string, input: CreateConversationInput) {
		const createdAt = input.createdAt ?? now();
		const record = {
			id: input.id ?? id(),
			userId,
			title: input.title,
			provider: input.provider ?? null,
			endpointId: input.endpointId ?? null,
			modelId: input.modelId ?? null,
			modelApi: input.modelApi ?? null,
			systemPrompt: input.systemPrompt ?? null,
			reasoningEffort: input.reasoningEffort ?? null,
			reasoningSummary: input.reasoningSummary ? 1 : 0,
			verbosity: input.verbosity ?? null,
			displayMode: input.displayMode ?? null,
			generationConfigJson: input.generationConfigJson ?? "{}",
			createdAt,
			updatedAt: createdAt,
			folderId: input.folderId ?? null,
		};
		await this.db.insertInto("v2_conversation").values(record).execute();
		return this.requireConversation(this.db, userId, record.id);
	}

	/** Deletes attachment metadata rows (already-validated as orphaned by the
	 * caller) and returns their storage keys so the caller can free the
	 * on-disk objects. */
	async deleteAttachments(attachmentIds: readonly string[]): Promise<string[]> {
		if (attachmentIds.length === 0) return [];
		const rows = await this.db
			.selectFrom("v2_attachment")
			.select("storageKey")
			.where("id", "in", attachmentIds)
			.execute();
		await this.db
			.deleteFrom("v2_attachment")
			.where("id", "in", attachmentIds)
			.execute();
		return rows.map((row) => row.storageKey);
	}

	async setConversationTitleIfDefault(
		userId: string,
		conversationId: string,
		title: string,
	): Promise<boolean> {
		const result = await this.db
			.updateTable("v2_conversation")
			.set({ title, updatedAt: now() })
			.where("id", "=", conversationId)
			.where("userId", "=", userId)
			.where("title", "=", "New conversation")
			.executeTakeFirst();
		return (result.numUpdatedRows ?? 0n) > 0n;
	}

	async createAttachment(
		userId: string,
		input: CreateAttachmentInput,
	): Promise<AttachmentRecord> {
		if (!Number.isInteger(input.byteSize) || input.byteSize < 0)
			throw new Error("attachment byteSize must be a non-negative integer");
		const record = {
			id: input.id ?? id(),
			userId,
			storageKey: input.storageKey,
			filename: input.filename,
			mimeType: input.mimeType,
			kind: input.kind,
			byteSize: input.byteSize,
			sha256: input.sha256,
			width: input.width ?? null,
			height: input.height ?? null,
			pageCount: input.pageCount ?? null,
			createdAt: input.createdAt ?? now(),
		};
		await this.db.insertInto("v2_attachment").values(record).execute();
		return record;
	}

	async bindAttachment(
		userId: string,
		conversationId: string,
		messageId: string,
		attachmentId: string,
		ordinal: number,
	): Promise<void> {
		if (!Number.isInteger(ordinal) || ordinal < 0)
			throw new Error("attachment ordinal must be a non-negative integer");
		await this.db.transaction().execute(async (trx) => {
			await this.requireConversation(trx, userId, conversationId);
			const message = await this.requireMessageForConversation(
				trx,
				userId,
				conversationId,
				messageId,
			);
			if (!message) throw new V2NotFoundError("message", messageId);
			await this.requireAttachment(trx, userId, attachmentId);
			await trx
				.insertInto("v2_message_attachment")
				.values({ messageId, attachmentId, ordinal })
				.execute();
			await trx
				.updateTable("v2_conversation")
				.set({ updatedAt: now() })
				.where("id", "=", conversationId)
				.execute();
		});
	}

	async listMessageAttachments(
		userId: string,
		conversationId: string,
	): Promise<Array<{ messageId: string; attachment: AttachmentRecord }>> {
		await this.requireConversation(this.db, userId, conversationId);
		const rows = await this.db
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
				"binding.ordinal as bindingOrdinal",
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
			.where("attachment.userId", "=", userId)
			.orderBy("binding.messageId")
			.orderBy("binding.ordinal")
			.execute();
		return rows.map(
			({ messageId, bindingOrdinal: _bindingOrdinal, ...attachment }) => ({
				messageId,
				attachment,
			}),
		);
	}

	async createFolder(userId: string, input: CreateOrganizationInput) {
		const record = {
			id: input.id ?? id(),
			userId,
			name: input.name,
			createdAt: input.createdAt ?? now(),
		};
		await this.db.insertInto("v2_folder").values(record).execute();
		return record;
	}

	async listFolders(userId: string) {
		return this.db
			.selectFrom("v2_folder")
			.select(["id", "name", "createdAt"])
			.where("userId", "=", userId)
			.orderBy("name", "asc")
			.execute();
	}

	async renameFolder(userId: string, folderId: string, name: string): Promise<void> {
		const result = await this.db
			.updateTable("v2_folder")
			.set({ name })
			.where("id", "=", folderId)
			.where("userId", "=", userId)
			.executeTakeFirst();
		if ((result.numUpdatedRows ?? 0n) === 0n)
			throw new V2NotFoundError("folder", folderId);
	}

	async deleteFolder(userId: string, folderId: string): Promise<void> {
		await this.db.transaction().execute(async (trx) => {
			const result = await trx
				.deleteFrom("v2_folder")
				.where("id", "=", folderId)
				.where("userId", "=", userId)
				.executeTakeFirst();
			if ((result.numDeletedRows ?? 0n) === 0n)
				throw new V2NotFoundError("folder", folderId);
			await trx
				.updateTable("v2_conversation")
				.set({ folderId: null })
				.where("folderId", "=", folderId)
				.where("userId", "=", userId)
				.execute();
		});
	}

	async createTag(userId: string, input: CreateOrganizationInput) {
		const record = {
			id: input.id ?? id(),
			userId,
			name: input.name,
			createdAt: input.createdAt ?? now(),
		};
		await this.db.insertInto("v2_tag").values(record).execute();
		return record;
	}

	async findTagByName(userId: string, name: string) {
		return this.db
			.selectFrom("v2_tag")
			.select("id")
			.where("userId", "=", userId)
			.where("name", "=", name)
			.executeTakeFirst();
	}

	async listTags(userId: string) {
		return this.db
			.selectFrom("v2_tag")
			.select(["id", "name", "createdAt"])
			.where("userId", "=", userId)
			.orderBy("name", "asc")
			.execute();
	}

	async deleteTag(userId: string, tagId: string): Promise<void> {
		const result = await this.db
			.deleteFrom("v2_tag")
			.where("id", "=", tagId)
			.where("userId", "=", userId)
			.executeTakeFirst();
		if ((result.numDeletedRows ?? 0n) === 0n)
			throw new V2NotFoundError("tag", tagId);
	}

	async renameConversation(
		userId: string,
		conversationId: string,
		title: string,
	): Promise<void> {
		await this.requireConversation(this.db, userId, conversationId);
		await this.db
			.updateTable("v2_conversation")
			.set({ title, updatedAt: now() })
			.where("id", "=", conversationId)
			.execute();
	}

	async setConversationFolder(
		userId: string,
		conversationId: string,
		folderId: string | null,
	): Promise<void> {
		await this.db.transaction().execute(async (trx) => {
			await this.requireConversation(trx, userId, conversationId);
			if (folderId) await this.requireFolder(trx, userId, folderId);
			await trx
				.updateTable("v2_conversation")
				.set({ folderId, updatedAt: now() })
				.where("id", "=", conversationId)
				.execute();
		});
	}

	async setConversationTags(
		userId: string,
		conversationId: string,
		tagIds: readonly string[],
	): Promise<void> {
		await this.db.transaction().execute(async (trx) => {
			await this.requireConversation(trx, userId, conversationId);
			for (const tagId of tagIds) await this.requireTag(trx, userId, tagId);
			await trx
				.deleteFrom("v2_conversation_tag")
				.where("conversationId", "=", conversationId)
				.execute();
			if (tagIds.length > 0)
				await trx
					.insertInto("v2_conversation_tag")
					.values(tagIds.map((tagId) => ({ conversationId, tagId })))
					.execute();
		});
	}

	async setConversationModel(
		userId: string,
		conversationId: string,
		selection: {
			provider: string;
			endpointId: string;
			modelId: string;
			modelApi: string;
		},
	): Promise<void> {
		await this.requireConversation(this.db, userId, conversationId);
		await this.db
			.updateTable("v2_conversation")
			.set({
				provider: selection.provider,
				endpointId: selection.endpointId,
				modelId: selection.modelId,
				modelApi: selection.modelApi,
				updatedAt: now(),
			})
			.where("id", "=", conversationId)
			.execute();
	}

	async setConversationGenerationSettings(
		userId: string,
		conversationId: string,
		settings: {
			reasoningEffort?: string | null;
			verbosity?: string | null;
			reasoningSummary?: boolean;
		},
	): Promise<void> {
		await this.requireConversation(this.db, userId, conversationId);
		await this.db
			.updateTable("v2_conversation")
			.set({
				...(settings.reasoningEffort !== undefined
					? { reasoningEffort: settings.reasoningEffort }
					: {}),
				...(settings.verbosity !== undefined
					? { verbosity: settings.verbosity }
					: {}),
				...(settings.reasoningSummary !== undefined
					? { reasoningSummary: settings.reasoningSummary ? 1 : 0 }
					: {}),
				updatedAt: now(),
			})
			.where("id", "=", conversationId)
			.execute();
	}

	async setConversationDisplayMode(
		userId: string,
		conversationId: string,
		displayMode: string,
	): Promise<void> {
		await this.requireConversation(this.db, userId, conversationId);
		await this.db
			.updateTable("v2_conversation")
			.set({ displayMode, updatedAt: now() })
			.where("id", "=", conversationId)
			.execute();
	}

	async setConversationAutoExecuteTools(
		userId: string,
		conversationId: string,
		enabled: boolean,
	): Promise<void> {
		await this.requireConversation(this.db, userId, conversationId);
		await this.db
			.updateTable("v2_conversation")
			.set({ autoExecuteTools: enabled ? 1 : 0, updatedAt: now() })
			.where("id", "=", conversationId)
			.execute();
	}

	async setConversationMcpServer(
		userId: string,
		conversationId: string,
		serverId: string,
		enabled: boolean,
	): Promise<void> {
		await this.requireConversation(this.db, userId, conversationId);
		await this.db
			.insertInto("v2_conversation_mcp_server")
			.values({ conversationId, serverId, enabled: enabled ? 1 : 0 })
			.onConflict((oc) =>
				oc
					.columns(["conversationId", "serverId"])
					.doUpdateSet({ enabled: enabled ? 1 : 0 }),
			)
			.execute();
	}

	async listConversationMcpServers(
		userId: string,
		conversationId: string,
	): Promise<{ serverId: string; enabled: boolean }[]> {
		await this.requireConversation(this.db, userId, conversationId);
		const rows = await this.db
			.selectFrom("v2_conversation_mcp_server")
			.select(["serverId", "enabled"])
			.where("conversationId", "=", conversationId)
			.execute();
		return rows.map((row) => ({
			serverId: row.serverId,
			enabled: Boolean(row.enabled),
		}));
	}

	async listConversations(userId: string): Promise<ConversationListRecord[]> {
		const conversations = await this.db
			.selectFrom("v2_conversation")
			.selectAll()
			.where("userId", "=", userId)
			.orderBy("updatedAt", "desc")
			.execute();
		const tags = await this.db
			.selectFrom("v2_conversation_tag as binding")
			.innerJoin("v2_tag as tag", "tag.id", "binding.tagId")
			.select(["binding.conversationId", "binding.tagId"])
			.where("tag.userId", "=", userId)
			.execute();
		const tagIdsByConversation = new Map<string, string[]>();
		for (const tag of tags)
			tagIdsByConversation.set(tag.conversationId, [
				...(tagIdsByConversation.get(tag.conversationId) ?? []),
				tag.tagId,
			]);
		return conversations.map((conversation) => ({
			...conversation,
			generationConfig: JSON.parse(conversation.generationConfigJson) as Record<
				string,
				unknown
			>,
			tagIds: tagIdsByConversation.get(conversation.id) ?? [],
		}));
	}

	async deleteConversation(
		userId: string,
		conversationId: string,
	): Promise<void> {
		await this.requireConversation(this.db, userId, conversationId);
		await this.db
			.deleteFrom("v2_conversation")
			.where("id", "=", conversationId)
			.execute();
	}

	/** Discards the user's abandoned drafts (conversations with no turns at
	 * all) so they never accumulate. */
	async deleteAbandonedConversations(userId: string): Promise<void> {
		const abandoned = await this.db
			.selectFrom("v2_conversation as conversation")
			.select("conversation.id")
			.where("conversation.userId", "=", userId)
			.where((eb) =>
				eb.not(
					eb.exists(
						eb
							.selectFrom("v2_conversation_turn")
							.select("v2_conversation_turn.id")
							.whereRef(
								"v2_conversation_turn.conversationId",
								"=",
								"conversation.id",
							),
					),
				),
			)
			.execute();
		if (abandoned.length === 0) return;
		await this.db
			.deleteFrom("v2_conversation")
			.where(
				"id",
				"in",
				abandoned.map((row) => row.id),
			)
			.execute();
	}

	async createTurn(
		userId: string,
		conversationId: string,
		input: CreateTurnInput,
	) {
		return this.db.transaction().execute(async (trx) => {
			await this.requireConversation(trx, userId, conversationId);
			const turnId = input.id ?? id();
			await trx
				.insertInto("v2_conversation_turn")
				.values({
					...input,
					id: turnId,
					conversationId,
					createdAt: input.createdAt ?? now(),
				})
				.execute();
			return this.requireTurn(trx, userId, turnId);
		});
	}

	/** Atomically opens a user turn + its canonical message + the placeholder
	 * assistant turn that will hold the reply. Ordinals are derived from the
	 * current max in a single transaction (not the message count, which is a
	 * different sequence once a turn spans multiple canonical messages), so a
	 * failed/aborted attempt never leaves a turn committed at an ordinal that
	 * blocks every subsequent retry with a UNIQUE constraint violation. */
	async startUserTurn(
		userId: string,
		conversationId: string,
		input: {
			userTurnId?: string;
			assistantTurnId?: string;
			userMessage: CanonicalMessageInput;
		},
	): Promise<{ userTurnId: string; assistantTurnId: string }> {
		return this.db.transaction().execute(async (trx) => {
			await this.requireConversation(trx, userId, conversationId);
			const maximum = await trx
				.selectFrom("v2_conversation_turn")
				.select((eb) => eb.fn.max<number>("ordinal").as("ordinal"))
				.where("conversationId", "=", conversationId)
				.executeTakeFirst();
			const firstOrdinal = (maximum?.ordinal ?? -1) + 1;
			const userTurnId = input.userTurnId ?? id();
			const assistantTurnId = input.assistantTurnId ?? id();
			const createdAt = now();
			await trx
				.insertInto("v2_conversation_turn")
				.values([
					{
						id: userTurnId,
						conversationId,
						ordinal: firstOrdinal,
						role: "user",
						origin: input.userMessage.origin,
						status: "complete",
						createdAt,
					},
					{
						id: assistantTurnId,
						conversationId,
						ordinal: firstOrdinal + 1,
						role: "assistant",
						origin: "text",
						status: "pending",
						createdAt,
					},
				])
				.execute();
			await this.appendCanonicalMessagesInTransaction(
				trx,
				userId,
				conversationId,
				[{ ...input.userMessage, turnId: userTurnId }],
			);
			return { userTurnId, assistantTurnId };
		});
	}

	async createGeneration(
		userId: string,
		conversationId: string,
		input: CreateGenerationInput,
	) {
		return this.db.transaction().execute(async (trx) => {
			await this.requireConversation(trx, userId, conversationId);
			if (input.turnId)
				await this.requireTurnForConversation(
					trx,
					userId,
					conversationId,
					input.turnId,
				);
			const generationId = input.id ?? id();
			await trx
				.insertInto("v2_generation")
				.values({
					...input,
					id: generationId,
					conversationId,
					turnId: input.turnId ?? null,
					createdAt: input.createdAt ?? now(),
				})
				.execute();
			return this.requireGeneration(trx, userId, generationId);
		});
	}

	async appendCanonicalMessages(
		userId: string,
		conversationId: string,
		messages: readonly CanonicalMessageInput[],
	) {
		const appended = await this.db
			.transaction()
			.execute(async (trx) =>
				this.appendCanonicalMessagesInTransaction(
					trx,
					userId,
					conversationId,
					messages,
				),
			);
		if (appended.length)
			logger
				.withMetadata({
					conversationId,
					messageIds: appended.map((message) => message.id),
				})
				.debug("chat-v2 canonical messages appended");
		return appended;
	}

	async deleteMessageSuffix(
		userId: string,
		conversationId: string,
		fromOrdinal: number,
	): Promise<void> {
		await this.db.transaction().execute(async (trx) => {
			await this.requireConversation(trx, userId, conversationId);
			await this.invalidateCompactionsIntersectingInTransaction(
				trx,
				userId,
				conversationId,
				fromOrdinal,
			);
			await trx
				.deleteFrom("v2_conversation_message")
				.where("conversationId", "=", conversationId)
				.where("ordinal", ">=", fromOrdinal)
				.execute();
		});
		logger
			.withMetadata({ conversationId, fromOrdinal })
			.debug("chat-v2 message suffix deleted");
	}

	async deleteConversationSuffix(
		userId: string,
		conversationId: string,
		fromTurnId: string,
	): Promise<SuffixDeletionResult> {
		return this.db
			.transaction()
			.execute(async (trx) =>
				this.deleteConversationSuffixInTransaction(
					trx,
					userId,
					conversationId,
					fromTurnId,
				),
			);
	}

	async editUserMessage(
		userId: string,
		conversationId: string,
		fromTurnId: string,
		input: EditUserMessageInput,
	): Promise<SuffixReplacementResult> {
		if (input.replacement.message.role !== "user")
			throw new Error("replacement message must have the user role");
		return this.db.transaction().execute(async (trx) => {
			const target = await this.requireLiveTurnForConversation(
				trx,
				userId,
				conversationId,
				fromTurnId,
			);
			if (target.role !== "user")
				throw new Error("edit target must be a user turn");
			const deleted = await this.deleteConversationSuffixInTransaction(
				trx,
				userId,
				conversationId,
				fromTurnId,
				target,
			);
			const userTurnId = input.userTurnId ?? id();
			const assistantTurnId = input.assistantTurnId ?? id();
			const createdAt = now();
			await trx
				.insertInto("v2_conversation_turn")
				.values([
					{
						id: userTurnId,
						conversationId,
						ordinal: target.ordinal,
						role: "user",
						origin: input.replacement.origin,
						status: input.replacement.status,
						createdAt,
					},
					{
						id: assistantTurnId,
						conversationId,
						ordinal: target.ordinal + 1,
						role: "assistant",
						origin: "text",
						status: "pending",
						createdAt,
					},
				])
				.execute();
			await this.appendCanonicalMessagesInTransaction(
				trx,
				userId,
				conversationId,
				[{ ...input.replacement, turnId: userTurnId }],
			);
			const generationId = await this.createGenerationInTransaction(
				trx,
				userId,
				conversationId,
				{ ...input.generation, turnId: assistantTurnId },
			);
			return { ...deleted, userTurnId, assistantTurnId, generationId };
		});
	}

	async regenerateAssistantTurn(
		userId: string,
		conversationId: string,
		fromTurnId: string,
		input: RegenerateAssistantTurnInput,
	): Promise<SuffixReplacementResult> {
		return this.db.transaction().execute(async (trx) => {
			const target = await this.requireLiveTurnForConversation(
				trx,
				userId,
				conversationId,
				fromTurnId,
			);
			if (target.role !== "assistant")
				throw new Error("regenerate target must be an assistant turn");
			const deleted = await this.deleteConversationSuffixInTransaction(
				trx,
				userId,
				conversationId,
				fromTurnId,
				target,
			);
			const assistantTurnId = input.assistantTurnId ?? id();
			await trx
				.insertInto("v2_conversation_turn")
				.values({
					id: assistantTurnId,
					conversationId,
					ordinal: target.ordinal,
					role: "assistant",
					origin: "text",
					status: "pending",
					createdAt: now(),
				})
				.execute();
			const generationId = await this.createGenerationInTransaction(
				trx,
				userId,
				conversationId,
				{ ...input.generation, turnId: assistantTurnId },
			);
			return { ...deleted, assistantTurnId, generationId };
		});
	}

	async finalizeGeneration(
		userId: string,
		generationId: string,
		input: FinalizeGenerationInput,
	): Promise<void> {
		await this.db.transaction().execute(async (trx) => {
			const generation = await this.requireGeneration(
				trx,
				userId,
				generationId,
			);
			await this.appendCanonicalMessagesInTransaction(
				trx,
				userId,
				generation.conversationId,
				input.messages,
			);
			const update = await trx
				.updateTable("v2_generation")
				.set({
					status: input.status,
					usageJson: input.usage ? JSON.stringify(input.usage) : null,
					stopReason: input.stopReason ?? null,
					errorMessage: input.errorMessage ?? null,
					finishedAt: input.finishedAt ?? now(),
				})
				.where("id", "=", generationId)
				.executeTakeFirst();
			if (Number(update.numUpdatedRows) !== 1)
				throw new V2NotFoundError("generation", generationId);
		});
	}

	async appendGenerationCheckpoint(
		userId: string,
		generationId: string,
		input: GenerationCheckpointInput,
	): Promise<boolean> {
		parseCanonicalMessage(input.message, { generationId });
		return this.db.transaction().execute(async (trx) => {
			const generation = await this.requireGeneration(
				trx,
				userId,
				generationId,
			);
			if (!isActiveGenerationStatus(generation.status)) return false;
			const createdAt = input.createdAt ?? now();
			await trx
				.updateTable("v2_generation")
				.set({
					status:
						generation.status === "queued" ? "running" : generation.status,
					partialMessageJson: JSON.stringify(input.message),
					startedAt: generation.startedAt ?? createdAt,
				})
				.where("id", "=", generationId)
				.execute();
			await this.appendGenerationEventInTransaction(
				trx,
				generationId,
				"checkpoint",
				{
					message: input.message,
				},
				createdAt,
			);
			return true;
		});
	}

	async completeGeneration(
		userId: string,
		generationId: string,
		input: {
			messages: readonly CanonicalMessageInput[];
			usage: Usage;
			stopReason: StopReason;
			finishedAt?: string;
		},
	): Promise<boolean> {
		const generation = await this.requireGeneration(
			this.db,
			userId,
			generationId,
		);
		const completed = await this.db
			.transaction()
			.execute((trx) =>
				this.completeGenerationInTransaction(trx, userId, generationId, input),
			);
		if (completed)
			logger
				.withMetadata({
					conversationId: generation.conversationId,
					turnId: generation.turnId ?? undefined,
					generationId,
				})
				.info("chat-v2 generation completed");
		return completed;
	}

	async completeVoiceTurn(
		userId: string,
		conversationId: string,
		input: CompleteVoiceTurnInput,
	): Promise<CompleteVoiceTurnResult> {
		return this.db.transaction().execute(async (trx) => {
			await this.requireConversation(trx, userId, conversationId);
			const existing = await trx
				.selectFrom("v2_voice_turn")
				.selectAll()
				.where("turnKey", "=", input.turnKey)
				.executeTakeFirst();
			if (existing) {
				if (existing.conversationId !== conversationId)
					throw new Error(
						`voice turn key ${input.turnKey} belongs to another conversation`,
					);
				return { voiceTurn: this.toVoiceTurnRecord(existing), created: false };
			}
			if (input.userMessage.message.role !== "user")
				throw new Error("voice user message must have the user role");
			if (input.assistantMessage.message.role !== "assistant")
				throw new Error("voice assistant message must have the assistant role");
			const maximum = await trx
				.selectFrom("v2_conversation_turn")
				.select((eb) => eb.fn.max<number>("ordinal").as("ordinal"))
				.where("conversationId", "=", conversationId)
				.executeTakeFirst();
			const firstOrdinal = (maximum?.ordinal ?? -1) + 1;
			const userTurnId = input.userTurnId ?? id();
			const assistantTurnId = input.assistantTurnId ?? id();
			const createdAt = now();
			await trx
				.insertInto("v2_conversation_turn")
				.values([
					{
						id: userTurnId,
						conversationId,
						ordinal: firstOrdinal,
						role: "user",
						origin: "voice",
						status: "complete",
						createdAt,
					},
					{
						id: assistantTurnId,
						conversationId,
						ordinal: firstOrdinal + 1,
						role: "assistant",
						origin: "voice",
						status: "complete",
						createdAt,
					},
				])
				.execute();
			await this.appendCanonicalMessagesInTransaction(
				trx,
				userId,
				conversationId,
				[
					{
						...input.userMessage,
						turnId: userTurnId,
						origin: "voice",
						status: "complete",
					},
				],
			);
			const generationId = await this.createGenerationInTransaction(
				trx,
				userId,
				conversationId,
				{
					id: input.generationId,
					turnId: assistantTurnId,
					status: "running",
					provider: input.provider,
					api: input.api,
					model: input.model,
					requestJson: input.requestJson,
				},
			);
			await this.completeGenerationInTransaction(trx, userId, generationId, {
				messages: [
					{
						...input.assistantMessage,
						turnId: assistantTurnId,
						origin: "voice",
						status: "complete",
					},
				],
				usage: input.usage,
				stopReason: input.stopReason,
			});
			const record = {
				turnKey: input.turnKey,
				conversationId,
				userTurnId,
				assistantTurnId,
				generationId,
				metadataJson: JSON.stringify(input.metadata),
				createdAt,
			};
			await trx.insertInto("v2_voice_turn").values(record).execute();
			return { voiceTurn: this.toVoiceTurnRecord(record), created: true };
		});
	}

	async stopGeneration(userId: string, generationId: string): Promise<boolean> {
		return this.finishActiveGeneration(userId, generationId, "stopped");
	}

	async failGeneration(
		userId: string,
		generationId: string,
		errorMessage: string,
	): Promise<boolean> {
		return this.finishActiveGeneration(
			userId,
			generationId,
			"failed",
			errorMessage,
		);
	}

	async reconcileRunningGenerations(userId: string): Promise<number> {
		return this.db.transaction().execute(async (trx) => {
			const generations = await trx
				.selectFrom("v2_generation as generation")
				.innerJoin(
					"v2_conversation as conversation",
					"conversation.id",
					"generation.conversationId",
				)
				.select(["generation.id"])
				.where("conversation.userId", "=", userId)
				.where("generation.status", "in", ["running", "streaming"])
				.execute();
			const finishedAt = now();
			for (const generation of generations) {
				await trx
					.updateTable("v2_generation")
					.set({ status: "interrupted", finishedAt })
					.where("id", "=", generation.id)
					.execute();
				await this.appendGenerationEventInTransaction(
					trx,
					generation.id,
					"interrupted",
					{},
					finishedAt,
				);
			}
			return generations.length;
		});
	}

	async listGenerationEvents(userId: string, generationId: string) {
		await this.requireGeneration(this.db, userId, generationId);
		return this.db
			.selectFrom("v2_generation_event")
			.selectAll()
			.where("generationId", "=", generationId)
			.orderBy("sequence")
			.execute();
	}

	async getConversation(userId: string, conversationId: string) {
		return this.requireConversation(this.db, userId, conversationId);
	}

	async getTurn(userId: string, turnId: string) {
		return this.requireTurn(this.db, userId, turnId);
	}

	/** Assistant-ui's reload passes an assistant message's *parent* id, which is
	 * the preceding user turn, not the assistant turn itself. Resolve that user
	 * turn to the assistant turn immediately following it (ordinal + 1). */
	async getAssistantTurnForUserTurn(userId: string, userTurnId: string) {
		const userTurn = await this.requireTurn(this.db, userId, userTurnId);
		const assistantTurn = await this.db
			.selectFrom("v2_conversation_turn")
			.selectAll()
			.where("conversationId", "=", userTurn.conversationId)
			.where("ordinal", "=", userTurn.ordinal + 1)
			.where("role", "=", "assistant")
			.executeTakeFirst();
		if (!assistantTurn)
			throw new V2NotFoundError("turn", userTurnId);
		return assistantTurn;
	}

	async getMessage(userId: string, messageId: string) {
		const record = await this.db
			.selectFrom("v2_conversation_message as message")
			.innerJoin(
				"v2_conversation as conversation",
				"conversation.id",
				"message.conversationId",
			)
			.selectAll("message")
			.where("message.id", "=", messageId)
			.where("conversation.userId", "=", userId)
			.executeTakeFirst();
		if (!record) throw new V2NotFoundError("message", messageId);
		return record;
	}

	async listCanonicalMessages(
		userId: string,
		conversationId: string,
	): Promise<CanonicalMessageRecord[]> {
		return this.listCanonicalMessagesInExecutor(
			this.db,
			userId,
			conversationId,
		);
	}

	async listCompactions(
		userId: string,
		conversationId: string,
	): Promise<ContextCompactionRecord[]> {
		await this.requireConversation(this.db, userId, conversationId);
		const rows = await this.db
			.selectFrom("v2_context_compaction")
			.selectAll()
			.where("conversationId", "=", conversationId)
			.orderBy("createdAt")
			.execute();
		return rows.map((row) => ({
			id: row.id,
			conversationId: row.conversationId,
			firstMessageId: row.firstMessageId,
			lastMessageId: row.lastMessageId,
			replacementMessages: JSON.parse(row.replacementMessagesJson) as Message[],
			sourceHash: row.sourceHash,
			promptVersion: row.promptVersion,
			provider: row.provider,
			api: row.api,
			model: row.model,
			tokensBefore: row.tokensBefore,
			tokensAfter: row.tokensAfter,
			createdAt: row.createdAt,
		}));
	}

	async listCompactionJobs(
		userId: string,
		conversationId: string,
	): Promise<ContextCompactionJobRecord[]> {
		await this.requireConversation(this.db, userId, conversationId);
		return this.db
			.selectFrom("v2_context_compaction_job")
			.selectAll()
			.where("conversationId", "=", conversationId)
			.orderBy("createdAt")
			.execute() as Promise<ContextCompactionJobRecord[]>;
	}

	async enqueueCompactionJob(
		userId: string,
		conversationId: string,
		input: EnqueueCompactionJobInput,
	): Promise<ContextCompactionJobRecord> {
		return this.db.transaction().execute(async (trx) => {
			const messages = await this.listCanonicalMessagesInExecutor(
				trx,
				userId,
				conversationId,
			);
			assertSafeCompactionRange(
				messages,
				input.firstMessageId,
				input.lastMessageId,
			);
			const first = messages.findIndex(
				(message) => message.id === input.firstMessageId,
			);
			const last = messages.findIndex(
				(message) => message.id === input.lastMessageId,
			);
			if (sourceHash(messages.slice(first, last + 1)) !== input.sourceHash)
				throw new Error(
					"compaction source hash does not match canonical history",
				);
			const record = {
				id: id(),
				conversationId,
				...input,
				status: "queued" as const,
				compactionId: null,
				errorMessage: null,
				createdAt: now(),
				finishedAt: null,
			};
			await trx
				.insertInto("v2_context_compaction_job")
				.values(record)
				.execute();
			return record;
		});
	}

	async startCompactionJob(
		userId: string,
		jobId: string,
	): Promise<ContextCompactionJobRecord> {
		return this.db.transaction().execute(async (trx) => {
			const job = await this.requireCompactionJob(trx, userId, jobId);
			if (job.status !== "queued")
				throw new Error(`compaction job ${jobId} is not queued`);
			await trx
				.updateTable("v2_context_compaction_job")
				.set({ status: "running" })
				.where("id", "=", jobId)
				.execute();
			return { ...job, status: "running" as const };
		});
	}

	async markCompactionJobStale(
		userId: string,
		jobId: string,
	): Promise<"stale"> {
		await this.updateCompactionJob(userId, jobId, {
			status: "stale",
			finishedAt: now(),
		});
		return "stale";
	}

	async failCompactionJob(
		userId: string,
		jobId: string,
		errorMessage: string,
	): Promise<void> {
		await this.updateCompactionJob(userId, jobId, {
			status: "failed",
			errorMessage,
			finishedAt: now(),
		});
	}

	async materializeCompactionJob(
		userId: string,
		jobId: string,
		input: MaterializeCompactionJobInput,
	): Promise<ContextCompactionRecord | "stale"> {
		validateMessageSequence(input.replacementMessages);
		const result = await this.db.transaction().execute(async (trx) => {
			const job = await this.requireCompactionJob(trx, userId, jobId);
			const messages = await this.listCanonicalMessagesInExecutor(
				trx,
				userId,
				job.conversationId,
			);
			const first = messages.findIndex(
				(message) => message.id === job.firstMessageId,
			);
			const last = messages.findIndex(
				(message) => message.id === job.lastMessageId,
			);
			if (
				first < 0 ||
				last < first ||
				sourceHash(messages.slice(first, last + 1)) !== job.sourceHash
			) {
				await trx
					.updateTable("v2_context_compaction_job")
					.set({ status: "stale", finishedAt: now() })
					.where("id", "=", jobId)
					.execute();
				return "stale";
			}
			assertSafeCompactionRange(
				messages,
				job.firstMessageId,
				job.lastMessageId,
			);
			const record = {
				id: input.id ?? id(),
				conversationId: job.conversationId,
				firstMessageId: job.firstMessageId,
				lastMessageId: job.lastMessageId,
				replacementMessages: [...input.replacementMessages],
				sourceHash: job.sourceHash,
				promptVersion: input.promptVersion,
				provider: input.provider ?? null,
				api: input.api ?? null,
				model: input.model ?? null,
				tokensBefore: input.tokensBefore ?? null,
				tokensAfter: input.tokensAfter ?? null,
				createdAt: now(),
			};
			await trx
				.insertInto("v2_context_compaction")
				.values({
					id: record.id,
					conversationId: record.conversationId,
					firstMessageId: record.firstMessageId,
					lastMessageId: record.lastMessageId,
					replacementMessagesJson: JSON.stringify(record.replacementMessages),
					sourceHash: record.sourceHash,
					promptVersion: record.promptVersion,
					provider: record.provider,
					api: record.api,
					model: record.model,
					tokensBefore: record.tokensBefore,
					tokensAfter: record.tokensAfter,
					createdAt: record.createdAt,
				})
				.execute();
			await trx
				.updateTable("v2_context_compaction_job")
				.set({ status: "complete", compactionId: record.id, finishedAt: now() })
				.where("id", "=", jobId)
				.execute();
			return record;
		});
		logger
			.withMetadata({
				compactionId: result === "stale" ? undefined : result.id,
				conversationId: result === "stale" ? undefined : result.conversationId,
			})
			.info(
				result === "stale"
					? "chat-v2 compaction stale"
					: "chat-v2 compaction materialized",
			);
		return result;
	}

	async recordGenerationContextManifest(
		userId: string,
		generationId: string,
		manifest: ContextManifest,
	): Promise<void> {
		await this.db.transaction().execute(async (trx) => {
			await this.requireGeneration(trx, userId, generationId);
			await trx
				.updateTable("v2_generation")
				.set({ contextManifestJson: JSON.stringify(manifest) })
				.where("id", "=", generationId)
				.execute();
		});
	}

	async getGeneration(userId: string, generationId: string) {
		return this.requireGeneration(this.db, userId, generationId);
	}

	async getGenerationForTurn(userId: string, turnId: string) {
		const record = await this.db
			.selectFrom("v2_generation as generation")
			.innerJoin(
				"v2_conversation as conversation",
				"conversation.id",
				"generation.conversationId",
			)
			.selectAll("generation")
			.where("generation.turnId", "=", turnId)
			.where("conversation.userId", "=", userId)
			.orderBy("generation.createdAt", "desc")
			.executeTakeFirst();
		if (!record) throw new V2NotFoundError("generation", turnId);
		return record;
	}

	/** Removes an attachment only if it has never been bound to a message
	 * (composer's "remove attachment before sending" action). */
	async removeOrphanAttachment(
		userId: string,
		attachmentId: string,
	): Promise<{ removed: boolean; storageKey?: string }> {
		const attachment = await this.db
			.selectFrom("v2_attachment")
			.select(["id", "storageKey"])
			.where("id", "=", attachmentId)
			.where("userId", "=", userId)
			.executeTakeFirst();
		if (!attachment) return { removed: false };
		const binding = await this.db
			.selectFrom("v2_message_attachment")
			.select("attachmentId")
			.where("attachmentId", "=", attachmentId)
			.executeTakeFirst();
		if (binding) return { removed: false };
		await this.db
			.deleteFrom("v2_attachment")
			.where("id", "=", attachmentId)
			.execute();
		return { removed: true, storageKey: attachment.storageKey };
	}

	async getAttachment(userId: string, attachmentId: string) {
		return this.requireAttachment(this.db, userId, attachmentId);
	}

	async getCompaction(userId: string, compactionId: string) {
		const record = await this.db
			.selectFrom("v2_context_compaction as compaction")
			.innerJoin(
				"v2_conversation as conversation",
				"conversation.id",
				"compaction.conversationId",
			)
			.selectAll("compaction")
			.where("compaction.id", "=", compactionId)
			.where("conversation.userId", "=", userId)
			.executeTakeFirst();
		if (!record) throw new V2NotFoundError("compaction", compactionId);
		return record;
	}

	async getCompactionJob(userId: string, jobId: string) {
		const record = await this.db
			.selectFrom("v2_context_compaction_job as job")
			.innerJoin(
				"v2_conversation as conversation",
				"conversation.id",
				"job.conversationId",
			)
			.selectAll("job")
			.where("job.id", "=", jobId)
			.where("conversation.userId", "=", userId)
			.executeTakeFirst();
		if (!record) throw new V2NotFoundError("compaction job", jobId);
		return record;
	}

	private async appendCanonicalMessagesInTransaction(
		trx: Transaction<Database>,
		userId: string,
		conversationId: string,
		messages: readonly CanonicalMessageInput[],
	) {
		await this.requireConversation(trx, userId, conversationId);
		if (messages.length === 0) return [];
		for (const input of messages) {
			parseCanonicalMessage(input.message, { conversationId });
			requireKnownValue(
				input.origin,
				CANONICAL_MESSAGE_ORIGINS,
				"message origin",
			);
			requireKnownValue(
				input.status,
				CANONICAL_MESSAGE_STATUSES,
				"message status",
			);
			if (input.turnId)
				await this.requireTurnForConversation(
					trx,
					userId,
					conversationId,
					input.turnId,
				);
		}
		const maximum = await trx
			.selectFrom("v2_conversation_message")
			.select((eb) => eb.fn.max<number>("ordinal").as("ordinal"))
			.where("conversationId", "=", conversationId)
			.executeTakeFirst();
		const firstOrdinal = (maximum?.ordinal ?? -1) + 1;
		const inserted = messages.map((input, index) => {
			const message = parseCanonicalMessage(input.message, { conversationId });
			return {
				id: input.id ?? id(),
				conversationId,
				turnId: input.turnId ?? null,
				ordinal: firstOrdinal + index,
				role: message.role,
				messageJson: JSON.stringify(message),
				origin: input.origin,
				status: input.status,
				createdAt: input.createdAt ?? now(),
			};
		});
		await trx.insertInto("v2_conversation_message").values(inserted).execute();
		return inserted;
	}

	private async createGenerationInTransaction(
		trx: Transaction<Database>,
		userId: string,
		conversationId: string,
		input: CreateGenerationInput,
	): Promise<string> {
		await this.requireConversation(trx, userId, conversationId);
		if (input.turnId)
			await this.requireTurnForConversation(
				trx,
				userId,
				conversationId,
				input.turnId,
			);
		const generationId = input.id ?? id();
		await trx
			.insertInto("v2_generation")
			.values({
				...input,
				id: generationId,
				conversationId,
				turnId: input.turnId ?? null,
				createdAt: input.createdAt ?? now(),
			})
			.execute();
		return generationId;
	}

	private async completeGenerationInTransaction(
		trx: Transaction<Database>,
		userId: string,
		generationId: string,
		input: {
			messages: readonly CanonicalMessageInput[];
			usage: Usage;
			stopReason: StopReason;
			finishedAt?: string;
		},
	): Promise<boolean> {
		const generation = await this.requireGeneration(trx, userId, generationId);
		if (!isActiveGenerationStatus(generation.status)) return false;
		const existing = await this.listCanonicalMessagesInExecutor(
			trx,
			userId,
			generation.conversationId,
		);
		validateMessageSequence([
			...existing.map((record) => record.message),
			...input.messages.map((message) => message.message),
		]);
		const finishedAt = input.finishedAt ?? now();
		await this.appendCanonicalMessagesInTransaction(
			trx,
			userId,
			generation.conversationId,
			input.messages,
		);
		await trx
			.updateTable("v2_generation")
			.set({
				status: "complete",
				partialMessageJson: null,
				usageJson: JSON.stringify(input.usage),
				stopReason: input.stopReason,
				errorMessage: null,
				finishedAt,
			})
			.where("id", "=", generationId)
			.execute();
		await this.appendGenerationEventInTransaction(
			trx,
			generationId,
			"complete",
			{
				messageCount: input.messages.length,
				usage: input.usage,
				stopReason: input.stopReason,
			},
			finishedAt,
		);
		return true;
	}

	private toVoiceTurnRecord(record: {
		turnKey: string;
		conversationId: string;
		userTurnId: string;
		assistantTurnId: string;
		generationId: string;
		metadataJson: string;
		createdAt: string;
	}): VoiceTurnRecord {
		const { metadataJson, ...voiceTurn } = record;
		return {
			...voiceTurn,
			metadata: JSON.parse(metadataJson) as VoiceMetadata,
		};
	}

	private async deleteConversationSuffixInTransaction(
		trx: Transaction<Database>,
		userId: string,
		conversationId: string,
		fromTurnId: string,
		target?: {
			id: string;
			conversationId: string;
			ordinal: number;
			role: string;
		},
	): Promise<SuffixDeletionResult> {
		const turn =
			target ??
			(await this.requireLiveTurnForConversation(
				trx,
				userId,
				conversationId,
				fromTurnId,
			));
		const deletedTurns = await trx
			.selectFrom("v2_conversation_turn")
			.select(["id", "ordinal"])
			.where("conversationId", "=", conversationId)
			.where("ordinal", ">=", turn.ordinal)
			.execute();
		const deletedTurnIds = deletedTurns.map((deletedTurn) => deletedTurn.id);
		const deletedMessages = await trx
			.selectFrom("v2_conversation_message")
			.select(["id", "ordinal"])
			.where("conversationId", "=", conversationId)
			.where("turnId", "in", deletedTurnIds)
			.execute();
		const fromOrdinal = deletedMessages.reduce(
			(minimum, message) => Math.min(minimum, message.ordinal),
			Number.MAX_SAFE_INTEGER,
		);
		if (fromOrdinal !== Number.MAX_SAFE_INTEGER)
			await this.invalidateCompactionsIntersectingInTransaction(
				trx,
				userId,
				conversationId,
				fromOrdinal,
			);
		const attachmentIds =
			deletedMessages.length === 0
				? []
				: (
						await trx
							.selectFrom("v2_message_attachment")
							.select("attachmentId")
							.where(
								"messageId",
								"in",
								deletedMessages.map((message) => message.id),
							)
							.distinct()
							.execute()
					).map((binding) => binding.attachmentId);
		const activeGenerations = await trx
			.selectFrom("v2_generation")
			.select("id")
			.where("conversationId", "=", conversationId)
			.where("turnId", "in", deletedTurnIds)
			.where("status", "in", ["queued", "running"])
			.execute();
		const finishedAt = now();
		for (const generation of activeGenerations) {
			await trx
				.updateTable("v2_generation")
				.set({ status: "interrupted", finishedAt })
				.where("id", "=", generation.id)
				.execute();
			await this.appendGenerationEventInTransaction(
				trx,
				generation.id,
				"interrupted",
				{ reason: "suffix_deleted" },
				finishedAt,
			);
		}
		await trx
			.deleteFrom("v2_generation")
			.where("conversationId", "=", conversationId)
			.where("turnId", "in", deletedTurnIds)
			.execute();
		if (deletedMessages.length > 0)
			await trx
				.deleteFrom("v2_message_attachment")
				.where(
					"messageId",
					"in",
					deletedMessages.map((message) => message.id),
				)
				.execute();
		const orphanedAttachmentIds: string[] = [];
		for (const attachmentId of attachmentIds) {
			const reference = await trx
				.selectFrom("v2_message_attachment")
				.select("attachmentId")
				.where("attachmentId", "=", attachmentId)
				.executeTakeFirst();
			if (!reference) orphanedAttachmentIds.push(attachmentId);
		}
		if (deletedMessages.length > 0)
			await trx
				.deleteFrom("v2_conversation_message")
				.where(
					"id",
					"in",
					deletedMessages.map((message) => message.id),
				)
				.execute();
		await trx
			.deleteFrom("v2_conversation_turn")
			.where("id", "in", deletedTurnIds)
			.execute();
		await trx
			.updateTable("v2_conversation")
			.set({ updatedAt: now() })
			.where("id", "=", conversationId)
			.execute();
		return {
			fromOrdinal: fromOrdinal === Number.MAX_SAFE_INTEGER ? 0 : fromOrdinal,
			orphanedAttachmentIds,
		};
	}

	private async finishActiveGeneration(
		userId: string,
		generationId: string,
		status: "stopped" | "failed",
		errorMessage: string | null = null,
	): Promise<boolean> {
		return this.db.transaction().execute(async (trx) => {
			const generation = await this.requireGeneration(
				trx,
				userId,
				generationId,
			);
			if (!isActiveGenerationStatus(generation.status)) return false;
			const finishedAt = now();
			await trx
				.updateTable("v2_generation")
				.set({ status, errorMessage, finishedAt })
				.where("id", "=", generationId)
				.execute();
			await this.appendGenerationEventInTransaction(
				trx,
				generationId,
				status,
				errorMessage ? { errorMessage } : {},
				finishedAt,
			);
			return true;
		});
	}

	private async appendGenerationEventInTransaction(
		trx: Transaction<Database>,
		generationId: string,
		kind: string,
		payload: Record<string, unknown>,
		createdAt: string,
	): Promise<void> {
		const maximum = await trx
			.selectFrom("v2_generation_event")
			.select((eb) => eb.fn.max<number>("sequence").as("sequence"))
			.where("generationId", "=", generationId)
			.executeTakeFirst();
		await trx
			.insertInto("v2_generation_event")
			.values({
				generationId,
				sequence: (maximum?.sequence ?? -1) + 1,
				kind,
				payloadJson: JSON.stringify(payload),
				createdAt,
			})
			.execute();
	}

	private async listCanonicalMessagesInExecutor(
		executor: Executor,
		userId: string,
		conversationId: string,
	): Promise<CanonicalMessageRecord[]> {
		await this.requireConversation(executor, userId, conversationId);
		const rows = await executor
			.selectFrom("v2_conversation_message")
			.selectAll()
			.where("conversationId", "=", conversationId)
			.orderBy("ordinal")
			.execute();
		const records = rows.map((row) => {
			let payload: unknown;
			try {
				payload = JSON.parse(row.messageJson);
			} catch {
				throw new CanonicalMessageValidationError("message JSON is invalid", {
					conversationId,
					messageId: row.id,
					ordinal: row.ordinal,
				});
			}
			const message = parseCanonicalMessage(payload, {
				conversationId,
				turnId: row.turnId ?? undefined,
				messageId: row.id,
				ordinal: row.ordinal,
			});
			if (message.role !== row.role)
				throw new CanonicalMessageValidationError(
					"message role does not match row role",
					{
						conversationId,
						turnId: row.turnId ?? undefined,
						messageId: row.id,
						ordinal: row.ordinal,
					},
				);
			return {
				id: row.id,
				conversationId: row.conversationId,
				turnId: row.turnId,
				ordinal: row.ordinal,
				role: row.role,
				message,
				origin: row.origin as CanonicalMessageOrigin,
				status: row.status as CanonicalMessageStatus,
				createdAt: row.createdAt,
			};
		});
		validateMessageSequence(
			records.map((record) => record.message),
			records.map((record) => ({
				conversationId,
				turnId: record.turnId ?? undefined,
				messageId: record.id,
				ordinal: record.ordinal,
			})),
		);
		return records;
	}

	private async invalidateCompactionsIntersectingInTransaction(
		trx: Transaction<Database>,
		userId: string,
		conversationId: string,
		fromOrdinal: number,
	): Promise<void> {
		const messages = await this.listCanonicalMessagesInExecutor(
			trx,
			userId,
			conversationId,
		);
		const ordinalById = new Map(
			messages.map((message) => [message.id, message.ordinal]),
		);
		const artifacts = await trx
			.selectFrom("v2_context_compaction")
			.select(["id", "lastMessageId"])
			.where("conversationId", "=", conversationId)
			.execute();
		const invalidArtifactIds = artifacts
			.filter((artifact) => {
				const lastOrdinal = ordinalById.get(artifact.lastMessageId);
				return lastOrdinal === undefined || lastOrdinal >= fromOrdinal;
			})
			.map((artifact) => artifact.id);
		if (invalidArtifactIds.length > 0)
			await trx
				.deleteFrom("v2_context_compaction")
				.where("id", "in", invalidArtifactIds)
				.execute();
		const jobs = await trx
			.selectFrom("v2_context_compaction_job")
			.selectAll()
			.where("conversationId", "=", conversationId)
			.where("status", "in", ["queued", "running"])
			.execute();
		for (const job of jobs) {
			const lastOrdinal = ordinalById.get(job.lastMessageId);
			if (lastOrdinal === undefined || lastOrdinal >= fromOrdinal)
				await trx
					.updateTable("v2_context_compaction_job")
					.set({ status: "stale", finishedAt: now() })
					.where("id", "=", job.id)
					.execute();
		}
	}

	private async updateCompactionJob(
		userId: string,
		jobId: string,
		update: {
			status: "stale" | "failed";
			errorMessage?: string;
			finishedAt: string;
		},
	): Promise<void> {
		await this.db.transaction().execute(async (trx) => {
			await this.requireCompactionJob(trx, userId, jobId);
			await trx
				.updateTable("v2_context_compaction_job")
				.set(update)
				.where("id", "=", jobId)
				.execute();
		});
	}

	private async requireConversation(
		executor: Executor,
		userId: string,
		conversationId: string,
	) {
		const record = await executor
			.selectFrom("v2_conversation")
			.selectAll()
			.where("id", "=", conversationId)
			.where("userId", "=", userId)
			.executeTakeFirst();
		if (!record) throw new V2NotFoundError("conversation", conversationId);
		return record;
	}

	private async requireAttachment(
		executor: Executor,
		userId: string,
		attachmentId: string,
	) {
		const record = await executor
			.selectFrom("v2_attachment")
			.selectAll()
			.where("id", "=", attachmentId)
			.where("userId", "=", userId)
			.executeTakeFirst();
		if (!record) throw new V2NotFoundError("attachment", attachmentId);
		return record;
	}

	private async requireMessageForConversation(
		executor: Executor,
		userId: string,
		conversationId: string,
		messageId: string,
	) {
		const message = await executor
			.selectFrom("v2_conversation_message as message")
			.innerJoin(
				"v2_conversation as conversation",
				"conversation.id",
				"message.conversationId",
			)
			.selectAll("message")
			.where("message.id", "=", messageId)
			.where("message.conversationId", "=", conversationId)
			.where("conversation.userId", "=", userId)
			.executeTakeFirst();
		if (!message) throw new V2NotFoundError("message", messageId);
		return message;
	}

	private async requireFolder(
		executor: Executor,
		userId: string,
		folderId: string,
	) {
		const folder = await executor
			.selectFrom("v2_folder")
			.selectAll()
			.where("id", "=", folderId)
			.where("userId", "=", userId)
			.executeTakeFirst();
		if (!folder) throw new V2NotFoundError("folder", folderId);
		return folder;
	}

	private async requireTag(executor: Executor, userId: string, tagId: string) {
		const tag = await executor
			.selectFrom("v2_tag")
			.selectAll()
			.where("id", "=", tagId)
			.where("userId", "=", userId)
			.executeTakeFirst();
		if (!tag) throw new V2NotFoundError("tag", tagId);
		return tag;
	}

	private async requireTurn(
		executor: Executor,
		userId: string,
		turnId: string,
	) {
		const record = await executor
			.selectFrom("v2_conversation_turn as turn")
			.innerJoin(
				"v2_conversation as conversation",
				"conversation.id",
				"turn.conversationId",
			)
			.selectAll("turn")
			.where("turn.id", "=", turnId)
			.where("conversation.userId", "=", userId)
			.executeTakeFirst();
		if (!record) throw new V2NotFoundError("turn", turnId);
		return record;
	}

	private async requireTurnForConversation(
		executor: Executor,
		userId: string,
		conversationId: string,
		turnId: string,
	) {
		const turn = await this.requireTurn(executor, userId, turnId);
		if (turn.conversationId !== conversationId)
			throw new V2NotFoundError("turn", turnId);
		return turn;
	}

	private async requireLiveTurnForConversation(
		executor: Executor,
		userId: string,
		conversationId: string,
		turnId: string,
	) {
		const turn = await executor
			.selectFrom("v2_conversation_turn as turn")
			.innerJoin(
				"v2_conversation as conversation",
				"conversation.id",
				"turn.conversationId",
			)
			.selectAll("turn")
			.where("turn.id", "=", turnId)
			.where("turn.conversationId", "=", conversationId)
			.where("conversation.userId", "=", userId)
			.executeTakeFirst();
		if (!turn) throw new V2StaleTargetError("turn", turnId);
		return turn;
	}

	private async requireGeneration(
		executor: Executor,
		userId: string,
		generationId: string,
	) {
		const record = await executor
			.selectFrom("v2_generation as generation")
			.innerJoin(
				"v2_conversation as conversation",
				"conversation.id",
				"generation.conversationId",
			)
			.selectAll("generation")
			.where("generation.id", "=", generationId)
			.where("conversation.userId", "=", userId)
			.executeTakeFirst();
		if (!record) throw new V2NotFoundError("generation", generationId);
		return record;
	}

	private async requireCompactionJob(
		executor: Executor,
		userId: string,
		jobId: string,
	) {
		const record = await executor
			.selectFrom("v2_context_compaction_job as job")
			.innerJoin(
				"v2_conversation as conversation",
				"conversation.id",
				"job.conversationId",
			)
			.selectAll("job")
			.where("job.id", "=", jobId)
			.where("conversation.userId", "=", userId)
			.executeTakeFirst();
		if (!record) throw new V2NotFoundError("compaction job", jobId);
		return record as ContextCompactionJobRecord;
	}
}
