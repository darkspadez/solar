import { sql, type Kysely } from "kysely";
import type { Database } from "../db/schema";
import { assertSafeCompactionRange, sourceHash } from "./context";
import type { ChatV2ExportBundle } from "./export";
import { CHAT_V2_EXPORT_VERSION } from "./export";
import type { CanonicalMessageRecord, ContextCompactionRecord } from "./types";
import { parseCanonicalMessage, validateMessageSequence } from "./validation";

export class ChatV2ImportValidationError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ChatV2ImportValidationError";
	}
}

export interface ImportWarning {
	code: "attachment_bytes_unavailable" | "compaction_dropped";
	detail: string;
}

export interface ChatV2ImportPlan {
	bundle: ChatV2ExportBundle;
	targetUserId: string;
	remap: boolean;
	idMap: Record<string, string>;
	validCompactionIds: string[];
	warnings: ImportWarning[];
	willCreate: Record<string, number>;
}

function required(value: unknown, name: string): asserts value is string {
	if (typeof value !== "string" || value.length === 0)
		throw new ChatV2ImportValidationError(`${name} must be a non-empty string`);
}

function timestamp(value: string | null, name: string): void {
	if (value !== null && !Number.isFinite(Date.parse(value)))
		throw new ChatV2ImportValidationError(`${name} must be an ISO timestamp`);
}

function ids(bundle: ChatV2ExportBundle): string[] {
	return [
		bundle.conversation.id,
		...bundle.turns.map((row) => row.id),
		...bundle.messages.map((row) => row.id),
		...bundle.attachments.map((row) => row.id),
		...bundle.generations.map((row) => row.id),
		...(bundle.compactions ?? []).map((row) => row.id),
		...(bundle.folder ? [bundle.folder.id] : []),
		...bundle.tags.map((row) => row.id),
	];
}

function mapped(plan: ChatV2ImportPlan, value: string | null): string | null {
	return value === null ? null : plan.idMap[value]!;
}

/** Validates a complete bundle and returns the exact, non-mutating import plan. */
export class ChatV2ImportService {
	constructor(private readonly db: Kysely<Database>) {}

	async plan(
		bundle: ChatV2ExportBundle,
		targetUserId: string,
		options: { remap?: boolean } = {},
	): Promise<ChatV2ImportPlan> {
		if (!bundle || bundle.version !== CHAT_V2_EXPORT_VERSION)
			throw new ChatV2ImportValidationError(
				"unsupported chat-v2 export version",
			);
		required(bundle.sourceUserId, "sourceUserId");
		if (bundle.sourceUserId !== targetUserId && !options.remap)
			throw new ChatV2ImportValidationError(
				"importing into another user requires remap mode",
			);
		const target = await sql<{
			id: string;
		}>`select id from user where id = ${targetUserId}`.execute(this.db);
		if (!target.rows[0])
			throw new ChatV2ImportValidationError("target user does not exist");
		required(bundle.conversation.id, "conversation.id");
		timestamp(bundle.conversation.createdAt, "conversation.createdAt");
		timestamp(bundle.conversation.updatedAt, "conversation.updatedAt");
		const allIds = ids(bundle);
		if (new Set(allIds).size !== allIds.length)
			throw new ChatV2ImportValidationError(
				"bundle contains duplicate entity IDs",
			);
		const turnIds = new Set(bundle.turns.map((turn) => turn.id));
		const messages: CanonicalMessageRecord[] = bundle.messages.map((row) => {
			if (
				row.conversationId !== bundle.conversation.id ||
				(row.turnId && !turnIds.has(row.turnId))
			)
				throw new ChatV2ImportValidationError(
					`message ${row.id} has an invalid conversation or turn reference`,
				);
			parseCanonicalMessage(row.message, {
				conversationId: row.conversationId,
				turnId: row.turnId ?? undefined,
				messageId: row.id,
				ordinal: row.ordinal,
			});
			timestamp(row.createdAt, `message ${row.id}.createdAt`);
			return row;
		});
		for (const [index, message] of messages.entries())
			if (!Number.isInteger(message.ordinal) || message.ordinal !== index)
				throw new ChatV2ImportValidationError(
					"message ordinals must be contiguous and start at zero",
				);
		validateMessageSequence(
			messages.map((message) => message.message),
			messages.map((message) => ({
				conversationId: message.conversationId,
				messageId: message.id,
				ordinal: message.ordinal,
			})),
		);
		for (const turn of bundle.turns) {
			if (
				turn.conversationId !== bundle.conversation.id ||
				!Number.isInteger(turn.ordinal) ||
				turn.ordinal < 0 ||
				!["user", "assistant"].includes(turn.role)
			)
				throw new ChatV2ImportValidationError(`turn ${turn.id} is invalid`);
			timestamp(turn.createdAt, `turn ${turn.id}.createdAt`);
		}
		if (
			new Set(bundle.turns.map((turn) => turn.ordinal)).size !==
			bundle.turns.length
		)
			throw new ChatV2ImportValidationError(
				"bundle contains duplicate turn ordinals",
			);
		if (
			bundle.conversation.folderId &&
			bundle.conversation.folderId !== bundle.folder?.id
		)
			throw new ChatV2ImportValidationError(
				"conversation folder reference is invalid",
			);
		if (bundle.folder) {
			required(bundle.folder.name, "folder.name");
			timestamp(bundle.folder.createdAt, "folder.createdAt");
		}
		for (const tag of bundle.tags) {
			required(tag.name, `tag ${tag.id}.name`);
			timestamp(tag.createdAt, `tag ${tag.id}.createdAt`);
		}
		const attachmentIds = new Set(
			bundle.attachments.map((attachment) => attachment.id),
		);
		for (const attachment of bundle.attachments) {
			required(attachment.storageKey, `attachment ${attachment.id}.storageKey`);
			required(attachment.sha256, `attachment ${attachment.id}.sha256`);
			if (!Number.isInteger(attachment.byteSize) || attachment.byteSize < 0)
				throw new ChatV2ImportValidationError(
					`attachment ${attachment.id}.byteSize is invalid`,
				);
			timestamp(attachment.createdAt, `attachment ${attachment.id}.createdAt`);
		}
		for (const binding of bundle.bindings)
			if (
				!messages.some((message) => message.id === binding.messageId) ||
				!attachmentIds.has(binding.attachmentId) ||
				!Number.isInteger(binding.ordinal) ||
				binding.ordinal < 0
			)
				throw new ChatV2ImportValidationError("attachment binding is invalid");
		for (const generation of bundle.generations) {
			if (
				generation.conversationId !== bundle.conversation.id ||
				(generation.turnId && !turnIds.has(generation.turnId))
			)
				throw new ChatV2ImportValidationError(
					`generation ${generation.id} has an invalid reference`,
				);
			timestamp(generation.createdAt, `generation ${generation.id}.createdAt`);
			timestamp(generation.startedAt, `generation ${generation.id}.startedAt`);
			timestamp(
				generation.finishedAt,
				`generation ${generation.id}.finishedAt`,
			);
			if (generation.partialMessage)
				parseCanonicalMessage(generation.partialMessage, {
					generationId: generation.id,
				});
		}
		const generationIds = new Set(
			bundle.generations.map((generation) => generation.id),
		);
		for (const event of bundle.generationEvents)
			if (
				!generationIds.has(event.generationId) ||
				!Number.isInteger(event.sequence) ||
				event.sequence < 0
			)
				throw new ChatV2ImportValidationError("generation event is invalid");
		for (const voice of bundle.voiceTurns) {
			if (
				voice.conversationId !== bundle.conversation.id ||
				!turnIds.has(voice.userTurnId) ||
				!turnIds.has(voice.assistantTurnId) ||
				!generationIds.has(voice.generationId)
			)
				throw new ChatV2ImportValidationError(
					`voice turn ${voice.turnKey} has an invalid reference`,
				);
			timestamp(voice.createdAt, `voice turn ${voice.turnKey}.createdAt`);
		}
		const warnings: ImportWarning[] = bundle.attachments.map((attachment) => ({
			code: "attachment_bytes_unavailable",
			detail: `attachment ${attachment.id} references ${attachment.storageKey}; bytes must be restored separately`,
		}));
		const validCompactionIds: string[] = [];
		for (const compaction of bundle.compactions ?? []) {
			try {
				if (compaction.conversationId !== bundle.conversation.id)
					throw new Error("conversation reference is invalid");
				const first = messages.findIndex(
					(message) => message.id === compaction.firstMessageId,
				);
				const last = messages.findIndex(
					(message) => message.id === compaction.lastMessageId,
				);
				if (
					first < 0 ||
					last < first ||
					sourceHash(messages.slice(first, last + 1)) !== compaction.sourceHash
				)
					throw new Error(
						"source hash does not match imported message sequence",
					);
				assertSafeCompactionRange(
					messages,
					compaction.firstMessageId,
					compaction.lastMessageId,
				);
				validateMessageSequence(compaction.replacementMessages);
				validCompactionIds.push(compaction.id);
			} catch (error) {
				warnings.push({
					code: "compaction_dropped",
					detail: `compaction ${compaction.id} dropped: ${error instanceof Error ? error.message : String(error)}`,
				});
			}
		}
		const collision = await this.hasCollision(bundle);
		if (collision && !options.remap)
			throw new ChatV2ImportValidationError(
				`target ID collision: ${collision}`,
			);
		const idMap = Object.fromEntries(
			allIds.map((source) => [
				source,
				options.remap ? crypto.randomUUID() : source,
			]),
		);
		return {
			bundle,
			targetUserId,
			remap: options.remap === true,
			idMap,
			validCompactionIds,
			warnings,
			willCreate: {
				conversations: 1,
				turns: bundle.turns.length,
				messages: bundle.messages.length,
				attachments: bundle.attachments.length,
				bindings: bundle.bindings.length,
				generations: bundle.generations.length,
				compactions: validCompactionIds.length,
				folders: bundle.folder ? 1 : 0,
				tags: bundle.tags.length,
			},
		};
	}

	async execute(
		plan: ChatV2ImportPlan,
	): Promise<{ conversationId: string; warnings: ImportWarning[] }> {
		const { bundle, targetUserId } = plan;
		await this.db.transaction().execute(async (trx) => {
			if (bundle.folder)
				await trx
					.insertInto("v2_folder")
					.values({
						id: mapped(plan, bundle.folder.id)!,
						userId: targetUserId,
						name: bundle.folder.name,
						createdAt: bundle.folder.createdAt,
					})
					.execute();
			if (bundle.tags.length)
				await trx
					.insertInto("v2_tag")
					.values(
						bundle.tags.map((tag) => ({
							id: mapped(plan, tag.id)!,
							userId: targetUserId,
							name: tag.name,
							createdAt: tag.createdAt,
						})),
					)
					.execute();
			await trx
				.insertInto("v2_conversation")
				.values({
					id: mapped(plan, bundle.conversation.id)!,
					userId: targetUserId,
					title: bundle.conversation.title,
					folderId: mapped(plan, bundle.conversation.folderId),
					provider: bundle.conversation.provider,
					endpointId: bundle.conversation.endpointId,
					modelId: bundle.conversation.modelId,
					modelApi: bundle.conversation.modelApi,
					systemPrompt: bundle.conversation.systemPrompt,
					generationConfigJson: JSON.stringify(
						bundle.conversation.generationConfig,
					),
					createdAt: bundle.conversation.createdAt,
					updatedAt: bundle.conversation.updatedAt,
				})
				.execute();
			if (bundle.turns.length)
				await trx
					.insertInto("v2_conversation_turn")
					.values(
						bundle.turns.map((turn) => ({
							...turn,
							id: mapped(plan, turn.id)!,
							conversationId: mapped(plan, turn.conversationId)!,
						})),
					)
					.execute();
			if (bundle.messages.length)
				await trx
					.insertInto("v2_conversation_message")
					.values(
						bundle.messages.map((message) => ({
							id: mapped(plan, message.id)!,
							conversationId: mapped(plan, message.conversationId)!,
							turnId: mapped(plan, message.turnId),
							ordinal: message.ordinal,
							role: message.role,
							messageJson: JSON.stringify(message.message),
							origin: message.origin,
							status: message.status,
							createdAt: message.createdAt,
						})),
					)
					.execute();
			if (bundle.attachments.length)
				await trx
					.insertInto("v2_attachment")
					.values(
						bundle.attachments.map((attachment) => ({
							...attachment,
							id: mapped(plan, attachment.id)!,
							userId: targetUserId,
							storageKey: plan.remap
								? `${mapped(plan, attachment.id)!}/${attachment.storageKey}`
								: attachment.storageKey,
						})),
					)
					.execute();
			if (bundle.bindings.length)
				await trx
					.insertInto("v2_message_attachment")
					.values(
						bundle.bindings.map((binding) => ({
							messageId: mapped(plan, binding.messageId)!,
							attachmentId: mapped(plan, binding.attachmentId)!,
							ordinal: binding.ordinal,
						})),
					)
					.execute();
			if (bundle.generations.length)
				await trx
					.insertInto("v2_generation")
					.values(
						bundle.generations.map((generation) => ({
							id: mapped(plan, generation.id)!,
							conversationId: mapped(plan, generation.conversationId)!,
							turnId: mapped(plan, generation.turnId),
							status: generation.status,
							provider: generation.provider,
							api: generation.api,
							model: generation.model,
							requestJson: JSON.stringify(generation.request),
							contextManifestJson: generation.contextManifest
								? JSON.stringify(generation.contextManifest)
								: null,
							partialMessageJson: generation.partialMessage
								? JSON.stringify(generation.partialMessage)
								: null,
							usageJson: generation.usage
								? JSON.stringify(generation.usage)
								: null,
							stopReason: generation.stopReason,
							errorMessage: generation.errorMessage,
							startedAt: generation.startedAt,
							finishedAt: generation.finishedAt,
							createdAt: generation.createdAt,
						})),
					)
					.execute();
			if (bundle.generationEvents.length)
				await trx
					.insertInto("v2_generation_event")
					.values(
						bundle.generationEvents.map((event) => ({
							...event,
							generationId: mapped(plan, event.generationId)!,
							payloadJson: JSON.stringify(event.payload),
						})),
					)
					.execute();
			const validCompactions = (bundle.compactions ?? []).filter((compaction) =>
				plan.validCompactionIds.includes(compaction.id),
			);
			if (validCompactions.length)
				await trx
					.insertInto("v2_context_compaction")
					.values(
						validCompactions.map((compaction) =>
							this.compactionValues(plan, compaction),
						),
					)
					.execute();
			if (bundle.tags.length)
				await trx
					.insertInto("v2_conversation_tag")
					.values(
						bundle.tags.map((tag) => ({
							conversationId: mapped(plan, bundle.conversation.id)!,
							tagId: mapped(plan, tag.id)!,
						})),
					)
					.execute();
			if (bundle.voiceTurns.length)
				await trx
					.insertInto("v2_voice_turn")
					.values(
						bundle.voiceTurns.map((voice) => ({
							turnKey: plan.remap ? crypto.randomUUID() : voice.turnKey,
							conversationId: mapped(plan, voice.conversationId)!,
							userTurnId: mapped(plan, voice.userTurnId)!,
							assistantTurnId: mapped(plan, voice.assistantTurnId)!,
							generationId: mapped(plan, voice.generationId)!,
							metadataJson: JSON.stringify(voice.metadata),
							createdAt: voice.createdAt,
						})),
					)
					.execute();
		});
		return {
			conversationId: mapped(plan, bundle.conversation.id)!,
			warnings: plan.warnings,
		};
	}

	private compactionValues(
		plan: ChatV2ImportPlan,
		compaction: ContextCompactionRecord,
	) {
		const messages = plan.bundle.messages.map((message) => ({
			...message,
			id: mapped(plan, message.id)!,
		}));
		const first = messages.findIndex(
			(message) => message.id === mapped(plan, compaction.firstMessageId),
		);
		const last = messages.findIndex(
			(message) => message.id === mapped(plan, compaction.lastMessageId),
		);
		return {
			id: mapped(plan, compaction.id)!,
			conversationId: mapped(plan, compaction.conversationId)!,
			firstMessageId: mapped(plan, compaction.firstMessageId)!,
			lastMessageId: mapped(plan, compaction.lastMessageId)!,
			replacementMessagesJson: JSON.stringify(compaction.replacementMessages),
			sourceHash: sourceHash(messages.slice(first, last + 1)),
			promptVersion: compaction.promptVersion,
			provider: compaction.provider,
			api: compaction.api,
			model: compaction.model,
			tokensBefore: compaction.tokensBefore,
			tokensAfter: compaction.tokensAfter,
			createdAt: compaction.createdAt,
		};
	}

	private async hasCollision(
		bundle: ChatV2ExportBundle,
	): Promise<string | null> {
		const checks: Array<[keyof Database, string[]]> = [
			["v2_conversation", [bundle.conversation.id]],
			["v2_conversation_turn", bundle.turns.map((row) => row.id)],
			["v2_conversation_message", bundle.messages.map((row) => row.id)],
			["v2_attachment", bundle.attachments.map((row) => row.id)],
			["v2_generation", bundle.generations.map((row) => row.id)],
			[
				"v2_context_compaction",
				(bundle.compactions ?? []).map((row) => row.id),
			],
			["v2_folder", bundle.folder ? [bundle.folder.id] : []],
			["v2_tag", bundle.tags.map((row) => row.id)],
		];
		for (const [table, values] of checks) {
			if (!values.length) continue;
			const collision = await this.db
				.selectFrom(table)
				.select("id")
				.where("id", "in", values)
				.executeTakeFirst();
			if (collision) return collision.id;
		}
		for (const attachment of bundle.attachments) {
			const collision = await this.db
				.selectFrom("v2_attachment")
				.select("storageKey")
				.where("storageKey", "=", attachment.storageKey)
				.executeTakeFirst();
			if (collision) return collision.storageKey;
		}
		return null;
	}
}
