import type { AssistantMessage, Context, Message } from "@earendil-works/pi-ai";
import { db } from "../db";
import { config } from "../config";
import { generationManager } from "./generationManager";
import { resolveSelection, type GenerationParams, type ModelSelection } from "./catalog";
import { ChatV2Repository } from "../chat-v2/db/repository";
import { GenerationService } from "../chat-v2/generation";
import { ChatV2EditService } from "../chat-v2/edit";
import { loadCanonicalHistory } from "../chat-v2/history";
import { materializeContext } from "../chat-v2/context";
import { enqueueCompactionForCompletedGeneration } from "../chat-v2/compactionScheduler";
import { CompactionService } from "../chat-v2/compaction";
import { createV2Summarizer } from "../chat-v2/summarizer";
import { projectVisibleTurns } from "../chat-v2/projection";
import { zeroUsage } from "../chat-v2/validation";
import { AttachmentService } from "../chat-v2/attachments";
import { logger } from "../logger";

export const chatV2Repository = new ChatV2Repository(db);
const generationService = new GenerationService(chatV2Repository);
const editService = new ChatV2EditService(chatV2Repository);

export function isChatV2Enabled(): boolean {
	return config.chatV2;
}

export async function ownsV2Conversation(userId: string, conversationId: string): Promise<boolean> {
	try {
		await chatV2Repository.getConversation(userId, conversationId);
		return true;
	} catch {
		return false;
	}
}

export async function ownsV2AssistantTurn(userId: string, turnId: string): Promise<boolean> {
	try {
		return (await chatV2Repository.getTurn(userId, turnId)).role === "assistant";
	} catch {
		return false;
	}
}

export async function ownsV2UserTurn(userId: string, turnId: string): Promise<boolean> {
	try {
		return (await chatV2Repository.getTurn(userId, turnId)).role === "user";
	} catch {
		return false;
	}
}

export async function sendV2Message(input: {
	userId: string;
	isAdmin: boolean;
	conversationId: string;
	text: string;
	attachmentIds?: string[];
}): Promise<string> {
	const conversation = await chatV2Repository.getConversation(input.userId, input.conversationId);
	const records = await chatV2Repository.listCanonicalMessages(input.userId, input.conversationId);
	const userTurnId = crypto.randomUUID();
	const assistantTurnId = crypto.randomUUID();
	const timestamp = Date.now();
	const userMessage: Message = { role: "user", content: input.text, timestamp };
	const attachments = new AttachmentService(chatV2Repository);
	for (const attachmentId of input.attachmentIds ?? [])
		await chatV2Repository.getAttachment(input.userId, attachmentId);
	await chatV2Repository.createTurn(input.userId, input.conversationId, {
		id: userTurnId,
		ordinal: records.length,
		role: "user",
		origin: "text",
		status: "complete",
	});
	await chatV2Repository.appendCanonicalMessages(input.userId, input.conversationId, [{
		id: userTurnId,
		turnId: userTurnId,
		message: userMessage,
		origin: "text",
		status: "complete",
	}]);
	for (const [ordinal, attachmentId] of (input.attachmentIds ?? []).entries())
		await attachments.bind(
			input.userId,
			input.conversationId,
			userTurnId,
			attachmentId,
			ordinal,
		);
	await chatV2Repository.createTurn(input.userId, input.conversationId, {
		id: assistantTurnId,
		ordinal: records.length + 1,
		role: "assistant",
		origin: "text",
		status: "pending",
	});

	const selection = await resolveSelection({
		provider: conversation.provider ?? undefined,
		endpointId: conversation.endpointId ?? undefined,
		modelId: conversation.modelId ?? undefined,
		api: conversation.modelApi ?? undefined,
	}, input.userId, input.isAdmin);
	const canonical = await chatV2Repository.listCanonicalMessages(input.userId, input.conversationId);
	const { context: messages, manifest } = materializeContext(
		input.conversationId,
		canonical,
		await chatV2Repository.listCompactions(input.userId, input.conversationId),
	);
	const context: Context = conversation.systemPrompt ? { systemPrompt: conversation.systemPrompt, messages } : { messages };
	const params: GenerationParams = { systemPrompt: conversation.systemPrompt ?? undefined, documents: [] };
	const generation = await generationService.startGeneration({
		userId: input.userId,
		conversationId: input.conversationId,
		turnId: assistantTurnId,
		provider: selection.provider,
		api: selection.api,
		model: selection.modelId,
		request: { messages },
		contextManifest: manifest,
	});
	startV2Generation({
		userId: input.userId,
		conversationId: input.conversationId,
		assistantTurnId,
		generationId: generation.id,
		context,
		selection,
		params,
	});
	return assistantTurnId;
}

export async function editV2UserMessage(input: {
	userId: string;
	isAdmin: boolean;
	conversationId: string;
	targetTurnId: string;
	text: string;
}): Promise<string> {
	const { selection, params } = await v2Selection(input.userId, input.isAdmin, input.conversationId);
	const assistantTurnId = crypto.randomUUID();
	const result = await editService.editUserMessage({
		userId: input.userId,
		conversationId: input.conversationId,
		targetTurnId: input.targetTurnId,
		message: { role: "user", content: input.text, timestamp: Date.now() },
		assistantTurnId,
		generation: v2GenerationInput(selection),
	});
	const context = await v2Context(input.userId, input.conversationId);
	startV2Generation({
		userId: input.userId,
		conversationId: input.conversationId,
		assistantTurnId: result.assistantTurnId,
		generationId: result.generationId,
		context,
		selection,
		params,
	});
	return result.assistantTurnId;
}

export async function regenerateV2AssistantTurn(input: {
	userId: string;
	isAdmin: boolean;
	conversationId: string;
	targetTurnId: string;
}): Promise<string> {
	const { selection, params } = await v2Selection(input.userId, input.isAdmin, input.conversationId);
	const assistantTurnId = crypto.randomUUID();
	const result = await editService.regenerateAssistantTurn({
		userId: input.userId,
		conversationId: input.conversationId,
		targetTurnId: input.targetTurnId,
		assistantTurnId,
		generation: v2GenerationInput(selection),
	});
	const context = await v2Context(input.userId, input.conversationId);
	startV2Generation({
		userId: input.userId,
		conversationId: input.conversationId,
		assistantTurnId: result.assistantTurnId,
		generationId: result.generationId,
		context,
		selection,
		params,
	});
	return result.assistantTurnId;
}

export async function stopV2Generation(userId: string, assistantTurnId: string): Promise<boolean> {
	try {
		const generation = await chatV2Repository.getGenerationForTurn(userId, assistantTurnId);
		const stopped = await generationService.stopGeneration(userId, generation.id);
		if (stopped) generationManager.stop(assistantTurnId);
		return stopped;
	} catch {
		return false;
	}
}

async function v2Selection(userId: string, isAdmin: boolean, conversationId: string) {
	const conversation = await chatV2Repository.getConversation(userId, conversationId);
	const selection = await resolveSelection({
		provider: conversation.provider ?? undefined,
		endpointId: conversation.endpointId ?? undefined,
		modelId: conversation.modelId ?? undefined,
		api: conversation.modelApi ?? undefined,
	}, userId, isAdmin);
	return {
		selection,
		params: { systemPrompt: conversation.systemPrompt ?? undefined, documents: [] } satisfies GenerationParams,
	};
}

async function v2Context(userId: string, conversationId: string): Promise<Context> {
	const conversation = await chatV2Repository.getConversation(userId, conversationId);
	const canonical = await chatV2Repository.listCanonicalMessages(userId, conversationId);
	const { context: messages } = materializeContext(
		conversationId,
		canonical,
		await chatV2Repository.listCompactions(userId, conversationId),
	);
	return conversation.systemPrompt ? { systemPrompt: conversation.systemPrompt, messages } : { messages };
}

function v2GenerationInput(selection: ModelSelection) {
	return {
		provider: selection.provider,
		api: selection.api,
		model: selection.modelId,
		request: { messages: [] },
	};
}

function startV2Generation(input: {
	userId: string;
	conversationId: string;
	assistantTurnId: string;
	generationId: string;
	context: Context;
	selection: ModelSelection;
	params: GenerationParams;
}): void {
	generationManager.start({
		conversationId: input.conversationId,
		messageId: input.assistantTurnId,
		context: input.context,
		selection: input.selection,
		params: input.params,
		persistExternally: async ({ parts, status, text }) => {
			if (status === "error") {
				await generationService.failGeneration(input.userId, input.generationId, new Error(text));
				return;
			}
			const message = canonicalAssistant(parts, input.selection, text);
			const completed = await generationService.completeGeneration(input.userId, input.generationId, [{
				id: input.assistantTurnId,
				turnId: input.assistantTurnId,
				message,
				origin: "text",
				status: "complete",
			}], message.usage, message.stopReason);
			if (completed)
				void enqueueCompactionForCompletedGeneration(
					chatV2Repository,
					input.userId,
					input.conversationId,
				)
					.then((jobId) => {
						// Compaction is asynchronous relative to the user's request, but
						// time-sensitive: begin running the job immediately rather than
						// waiting on any external scheduler.
						if (!jobId) return;
						void new CompactionService(chatV2Repository)
							.run(input.userId, jobId, createV2Summarizer(input.selection))
							.catch((error) =>
								logger
									.withError(error)
									.withMetadata({ conversationId: input.conversationId, jobId })
									.warn("chat-v2 compaction run failed"),
							);
					})
					.catch((error) =>
						logger.withError(error).withMetadata({ conversationId: input.conversationId }).warn("chat-v2 compaction enqueue failed"),
					);
		},
	});
}

function canonicalAssistant(parts: unknown, selection: { provider: string; api: string; modelId: string }, text: string): AssistantMessage {
	if (parts && typeof parts === "object") {
		const message = parts as AssistantMessage;
		return { ...message, usage: canonicalUsage(message.usage) };
	}
	return {
		role: "assistant",
		content: [{ type: "text", text: text || "Generation stopped" }],
		timestamp: Date.now(),
		api: selection.api,
		provider: selection.provider,
		model: selection.modelId,
		usage: zeroUsage(),
		stopReason: "stop",
	};
}

function canonicalUsage(usage: AssistantMessage["usage"] | undefined) {
	const defaults = zeroUsage();
	return {
		...defaults,
		...usage,
		cacheRead: usage?.cacheRead ?? 0,
		cacheWrite: usage?.cacheWrite ?? 0,
		totalTokens: usage?.totalTokens ?? (usage?.input ?? 0) + (usage?.output ?? 0),
		cost: { ...defaults.cost, ...usage?.cost },
	};
}

export async function loadV2Messages(userId: string, conversationId: string) {
	const records = await chatV2Repository.listCanonicalMessages(userId, conversationId);
	const attachmentsByMessageId = new Map<string, import("../chat-v2/types").AttachmentRecord[]>();
	for (const { messageId, attachment } of await chatV2Repository.listMessageAttachments(userId, conversationId))
		attachmentsByMessageId.set(messageId, [
			...(attachmentsByMessageId.get(messageId) ?? []),
			attachment,
		]);
	// Keep the public route's history reconstruction on the canonical v2 loader.
	await loadCanonicalHistory(chatV2Repository, userId, conversationId);
	return projectVisibleTurns(records, attachmentsByMessageId).map((turn) => ({
		id: turn.id,
		role: turn.role,
		text: turn.displayText,
		parts: JSON.stringify(turn.messages.at(-1)?.message ?? null),
		status: turn.status === "pending" ? "generating" : turn.status,
		createdAt: turn.messages[0]!.createdAt,
		reasoning: turn.reasoning.join("\n"),
		toolCalls: [],
		skillInvocation: null,
		attachments: turn.attachments.map(({ id, filename, mimeType, kind }) => ({
			id,
			filename,
			mimeType,
			kind: kind as "image" | "text" | "document",
		})),
		isActive: turn.status === "pending" && generationManager.isActive(turn.id),
	}));
}

export async function createV2Conversation(input: {
	userId: string;
	title: string;
	provider: string | null;
	endpointId: string | null;
	modelId: string | null;
	modelApi: string | null;
	systemPrompt: string | null;
}): Promise<string> {
	const conversation = await chatV2Repository.createConversation(input.userId, {
		title: input.title,
		provider: input.provider,
		endpointId: input.endpointId,
		modelId: input.modelId,
		modelApi: input.modelApi,
		systemPrompt: input.systemPrompt,
	});
	return conversation.id;
}
