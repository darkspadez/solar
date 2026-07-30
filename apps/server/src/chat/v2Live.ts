import type {
	AssistantMessage,
	Context,
	Message,
	TextContent,
} from "@earendil-works/pi-ai";
import {
	convertToLlm,
	createCompactionSummaryMessage,
	DEFAULT_COMPACTION_SETTINGS,
} from "@earendil-works/pi-agent-core";
import { db } from "../db";
import { generationManager } from "./generationManager";
import {
	documentInputCapabilities,
	getModelCapabilities,
	getTitlePrompt,
	listAvailableModels,
	resolveModel,
	resolveSelection,
	resolveTaskModelOrFallback,
	type GenerationParams,
	type ModelSelection,
} from "./catalog";
import { toolProvider } from "./tools";
import { describeToolNames, type ResolvedTool } from "./mcp";
import {
	contextualUserText,
	listExposedSkills,
	skillCatalogContext,
	skillInvocationContext,
} from "./skills";
import {
	deleteAttachmentFilesByStorageKey,
	expandAttachmentRows,
	type AttachmentContentRow,
} from "./attachments";
import {
	renderBuiltinPromptInterpolations,
	type UserLocation,
} from "./builtins";
import { ChatV2Repository } from "../chat-v2/db/repository";
import { GenerationService } from "../chat-v2/generation";
import { ChatV2EditService } from "../chat-v2/edit";
import { loadCanonicalHistory } from "../chat-v2/history";
import { materializeContext } from "../chat-v2/context";
import {
	enqueueCompactionForCompletedGeneration,
	type CompactionTriggerPolicy,
} from "../chat-v2/compactionScheduler";
import { CompactionService } from "../chat-v2/compaction";
import { createV2Summarizer } from "../chat-v2/summarizer";
import { projectVisibleTurns, type VisibleTurn } from "../chat-v2/projection";
import { zeroUsage } from "../chat-v2/validation";
import { AttachmentService } from "../chat-v2/attachments";
import { logger } from "../logger";

export const chatV2Repository = new ChatV2Repository(db);
const generationService = new GenerationService(chatV2Repository);
const editService = new ChatV2EditService(
	chatV2Repository,
	async (attachmentIds) => {
		const storageKeys = await chatV2Repository.deleteAttachments(attachmentIds);
		await deleteAttachmentFilesByStorageKey(storageKeys);
	},
);

export async function ownsConversation(
	userId: string,
	conversationId: string,
): Promise<boolean> {
	try {
		await chatV2Repository.getConversation(userId, conversationId);
		return true;
	} catch {
		return false;
	}
}

export async function ownsAssistantTurn(
	userId: string,
	turnId: string,
): Promise<boolean> {
	try {
		return (
			(await chatV2Repository.getTurn(userId, turnId)).role === "assistant"
		);
	} catch {
		return false;
	}
}

export async function ownsUserTurn(
	userId: string,
	turnId: string,
): Promise<boolean> {
	try {
		return (await chatV2Repository.getTurn(userId, turnId)).role === "user";
	} catch {
		return false;
	}
}

/** Skill-invocation instructions are appended to the outbound copy of the
 * user's message as an extra text part, tagged so display/search always
 * derive only the user-visible text. */
const SKILL_INVOCATION_SIGNATURE = "solar-skill-invocation";

function withSkillInvocation(
	message: Message,
	invocation: { name: string; content: string },
): Message {
	if (message.role !== "user") return message;
	const base: TextContent[] =
		typeof message.content === "string"
			? [{ type: "text", text: message.content }]
			: message.content.filter(
					(part): part is TextContent => part.type === "text",
				);
	const rest =
		typeof message.content === "string"
			? []
			: message.content.filter((part) => part.type !== "text");
	return {
		...message,
		content: [
			...base,
			...rest,
			{
				type: "text",
				text: skillInvocationContext(invocation),
				textSignature: SKILL_INVOCATION_SIGNATURE,
			} as TextContent,
		],
	};
}

async function conversationSelection(
	userId: string,
	isAdmin: boolean,
	conversationId: string,
) {
	const conversation = await chatV2Repository.getConversation(
		userId,
		conversationId,
	);
	const selection = await resolveSelection(
		{
			provider: conversation.provider ?? undefined,
			endpointId: conversation.endpointId ?? undefined,
			modelId: conversation.modelId ?? undefined,
			api: conversation.modelApi ?? undefined,
		},
		userId,
		isAdmin,
	);
	return { conversation, selection };
}

/** Prefetches and resolves every attachment referenced anywhere in the
 * conversation's canonical history into base64/extracted-text content, so
 * `materializeContext`'s (synchronous) attachment resolver can look results
 * up without any I/O. */
async function buildAttachmentExpansion(
	userId: string,
	conversationId: string,
	selection: ModelSelection,
) {
	const bindings = await chatV2Repository.listMessageAttachments(
		userId,
		conversationId,
	);
	const attachmentsByMessageId = new Map<
		string,
		(typeof bindings)[number]["attachment"][]
	>();
	for (const { messageId, attachment } of bindings)
		attachmentsByMessageId.set(messageId, [
			...(attachmentsByMessageId.get(messageId) ?? []),
			attachment,
		]);

	const documentInput = await documentInputCapabilities(selection);
	const rows: AttachmentContentRow[] = bindings.map(({ attachment }) => ({
		id: attachment.id,
		storageKey: attachment.storageKey,
		kind: attachment.kind as AttachmentContentRow["kind"],
		mimeType: attachment.mimeType,
		filename: attachment.filename,
	}));
	const expanded = await expandAttachmentRows(rows, documentInput);
	const resolvedById = new Map<
		string,
		{ type: "image"; data: string } | { type: "text"; text: string }
	>();
	for (const [index, row] of rows.entries()) {
		const part = expanded.parts[index];
		if (!part) continue;
		if (part.type === "image")
			resolvedById.set(row.id, { type: "image", data: part.data });
		else resolvedById.set(row.id, { type: "text", text: part.text });
	}

	const available = await listAvailableModels(true);
	const descriptor = available.find(
		(m) =>
			m.provider === selection.provider &&
			m.endpointId === selection.endpointId &&
			m.modelId === selection.modelId &&
			m.api === selection.api,
	);

	return {
		attachmentsByMessageId,
		capabilities: { supportsImages: descriptor?.vision ?? false },
		resolve: (attachment: { id: string }) =>
			resolvedById.get(attachment.id) ?? null,
	};
}

async function buildOutboundContext(
	userId: string,
	conversationId: string,
	selection: ModelSelection,
	systemPrompt: string | null,
) {
	const canonical = await chatV2Repository.listCanonicalMessages(
		userId,
		conversationId,
	);
	const compactions = await chatV2Repository.listCompactions(
		userId,
		conversationId,
	);
	const attachmentExpansion = await buildAttachmentExpansion(
		userId,
		conversationId,
		selection,
	);
	const { context: messages, manifest } = materializeContext(
		conversationId,
		canonical,
		compactions,
		attachmentExpansion,
	);
	const skills = skillCatalogContext(await listExposedSkills(userId));
	const messagesWithCatalog = skills
		? [
				{ role: "user" as const, content: skills, timestamp: Date.now() },
				...messages,
			]
		: messages;
	const context: Context = systemPrompt
		? { systemPrompt, messages: messagesWithCatalog }
		: { messages: messagesWithCatalog };
	return { context, manifest };
}

export interface SendMessageInput {
	userId: string;
	isAdmin: boolean;
	conversationId: string;
	text: string;
	attachmentIds?: string[];
	skillName?: string;
	userLocation?: UserLocation;
}

async function resolveSkill(userId: string, skillName: string | undefined) {
	if (!skillName) return null;
	const skills = await listExposedSkills(userId);
	const skill = skills.find((candidate) => candidate.name === skillName);
	if (!skill) throw new Error("skill not found");
	return { name: skill.name, content: skill.content };
}

export async function sendMessage(input: SendMessageInput): Promise<string> {
	const conversation = await chatV2Repository.getConversation(
		input.userId,
		input.conversationId,
	);
	const isFirstMessage =
		(
			await chatV2Repository.listCanonicalMessages(
				input.userId,
				input.conversationId,
			)
		).length === 0;
	const timestamp = Date.now();
	const invocation = await resolveSkill(input.userId, input.skillName);
	const rawMessage: Message = { role: "user", content: input.text, timestamp };
	const userMessage = invocation
		? withSkillInvocation(rawMessage, invocation)
		: rawMessage;

	const attachments = new AttachmentService(chatV2Repository);
	for (const attachmentId of input.attachmentIds ?? [])
		await chatV2Repository.getAttachment(input.userId, attachmentId);

	const { userTurnId, userMessageId, assistantTurnId } =
		await chatV2Repository.startUserTurn(input.userId, input.conversationId, {
			userMessage: {
				message: userMessage,
				origin: "text",
				status: "complete",
			},
		});
	for (const [ordinal, attachmentId] of (input.attachmentIds ?? []).entries())
		await attachments.bind(
			input.userId,
			input.conversationId,
			userMessageId,
			attachmentId,
			ordinal,
		);

	await startAssistantTurn({
		userId: input.userId,
		isAdmin: input.isAdmin,
		conversationId: input.conversationId,
		assistantTurnId,
		conversation,
		userLocation: input.userLocation,
		titleGeneration: isFirstMessage ? { firstMessage: input.text } : undefined,
	});
	return assistantTurnId;
}

export interface EditUserMessageInput {
	userId: string;
	isAdmin: boolean;
	conversationId: string;
	targetTurnId: string;
	text: string;
	userLocation?: UserLocation;
}

export async function editUserMessage(
	input: EditUserMessageInput,
): Promise<string> {
	const conversation = await chatV2Repository.getConversation(
		input.userId,
		input.conversationId,
	);
	const assistantTurnId = crypto.randomUUID();
	const result = await editService.editUserMessage({
		userId: input.userId,
		conversationId: input.conversationId,
		targetTurnId: input.targetTurnId,
		message: { role: "user", content: input.text, timestamp: Date.now() },
		assistantTurnId,
		generation: {
			provider: "pending",
			api: "pending",
			model: "pending",
			request: {},
		},
	});
	await startAssistantTurn({
		userId: input.userId,
		isAdmin: input.isAdmin,
		conversationId: input.conversationId,
		assistantTurnId: result.assistantTurnId,
		conversation,
		userLocation: input.userLocation,
	});
	return result.assistantTurnId;
}

export interface RegenerateAssistantTurnInput {
	userId: string;
	isAdmin: boolean;
	conversationId: string;
	targetTurnId: string;
	userLocation?: UserLocation;
}

export async function regenerateAssistantTurn(
	input: RegenerateAssistantTurnInput,
): Promise<string> {
	const conversation = await chatV2Repository.getConversation(
		input.userId,
		input.conversationId,
	);
	const assistantTurnId = crypto.randomUUID();
	const result = await editService.regenerateAssistantTurn({
		userId: input.userId,
		conversationId: input.conversationId,
		targetTurnId: input.targetTurnId,
		assistantTurnId,
		generation: {
			provider: "pending",
			api: "pending",
			model: "pending",
			request: {},
		},
	});
	await startAssistantTurn({
		userId: input.userId,
		isAdmin: input.isAdmin,
		conversationId: input.conversationId,
		assistantTurnId: result.assistantTurnId,
		conversation,
		userLocation: input.userLocation,
	});
	return result.assistantTurnId;
}

export async function stopGeneration(
	userId: string,
	assistantTurnId: string,
): Promise<boolean> {
	try {
		const generation = await chatV2Repository.getGenerationForTurn(
			userId,
			assistantTurnId,
		);
		const stopped = await generationService.stopGeneration(
			userId,
			generation.id,
		);
		if (stopped) generationManager.stop(assistantTurnId);

		const existing = await chatV2Repository.listCanonicalMessages(
			userId,
			generation.conversationId,
		);
		const hasTurnMessage = existing.some((m) => m.turnId === assistantTurnId);
		if (!hasTurnMessage) {
			const partialMessage = generation.partialMessageJson
				? (JSON.parse(generation.partialMessageJson) as Message)
				: null;
			const message: Message = partialMessage ?? {
				role: "assistant",
				content: [{ type: "text", text: "_Generation stopped_" }],
				provider: generation.provider ?? "system",
				api: generation.api ?? "system",
				model: generation.model ?? "system",
				usage: zeroUsage(),
				stopReason: "stop",
				timestamp: Date.now(),
			};
			await chatV2Repository.appendCanonicalMessages(
				userId,
				generation.conversationId,
				[
					{
						id: assistantTurnId,
						turnId: assistantTurnId,
						message,
						origin: "text",
						status: "complete",
					},
				],
			);
		}
		return stopped;
	} catch {
		return false;
	}
}

async function startAssistantTurn(input: {
	userId: string;
	isAdmin: boolean;
	conversationId: string;
	assistantTurnId: string;
	conversation: Awaited<ReturnType<typeof chatV2Repository.getConversation>>;
	userLocation?: UserLocation;
	titleGeneration?: { firstMessage: string };
}): Promise<void> {
	const selection = await resolveSelection(
		{
			provider: input.conversation.provider ?? undefined,
			endpointId: input.conversation.endpointId ?? undefined,
			modelId: input.conversation.modelId ?? undefined,
			api: input.conversation.modelApi ?? undefined,
		},
		input.userId,
		input.isAdmin,
	);
	await chatV2Repository.setConversationModel(
		input.userId,
		input.conversationId,
		{
			provider: selection.provider,
			endpointId: selection.endpointId,
			modelId: selection.modelId,
			modelApi: selection.api,
		},
	);

	const capabilities = await getModelCapabilities(selection);
	const systemPrompt =
		renderBuiltinPromptInterpolations(
			input.conversation.systemPrompt,
			input.userLocation,
		) ?? null;
	const { context, manifest } = await buildOutboundContext(
		input.userId,
		input.conversationId,
		selection,
		systemPrompt,
	);

	const availableTools = await toolProvider.resolve({
		userId: input.userId,
		conversationId: input.conversationId,
		userLocation: input.userLocation,
	});
	const resolvedTools = input.conversation.autoExecuteTools
		? availableTools
		: availableTools.filter((tool) => tool.tool.name === "read_skill");
	context.tools = resolvedTools.map(({ tool }) => tool);

	const params: GenerationParams = {
		systemPrompt: systemPrompt ?? undefined,
		reasoningEffort:
			input.conversation.reasoningEffort ??
			capabilities.defaultReasoningEffort ??
			undefined,
		reasoningSummary: Boolean(input.conversation.reasoningSummary),
		verbosity:
			input.conversation.verbosity ??
			capabilities.defaultVerbosity ??
			undefined,
		documents: [],
	};

	const titleTask = input.titleGeneration
		? {
				firstMessage: input.titleGeneration.firstMessage,
				prompt: await getTitlePrompt(),
				selection: await resolveTaskModelOrFallback(selection),
				persistTitle: async (title: string) =>
					chatV2Repository.setConversationTitleIfDefault(
						input.userId,
						input.conversationId,
						title,
					),
			}
		: undefined;

	const generation = await generationService.startGeneration({
		userId: input.userId,
		conversationId: input.conversationId,
		turnId: input.assistantTurnId,
		provider: selection.provider,
		api: selection.api,
		model: selection.modelId,
		request: { messages: context.messages },
		contextManifest: manifest,
	});

	generationManager.start({
		conversationId: input.conversationId,
		messageId: input.assistantTurnId,
		context,
		selection,
		params,
		tools: resolvedTools,
		titleGeneration: titleTask,
		// A genuine context-overflow refusal from the provider is real signal,
		// not something to hide — but we can still recover in place instead of
		// dying on it: force a compaction pass (ignoring the soft trigger, since
		// the provider already told us we're over budget) and retry once with
		// the rebuilt, shorter context.
		retryContext: async () => {
			const rebuilt = await forceCompactAndRebuildContext(
				input.userId,
				input.conversationId,
				selection,
				systemPrompt,
			);
			rebuilt.context.tools = resolvedTools.map(({ tool }) => tool);
			return { context: rebuilt.context, params };
		},
		persist: async ({ steps, parts, status, text }) => {
			const stepMessages = (steps as Message[]).filter(
				(step) =>
					step && (step.role === "assistant" || step.role === "toolResult"),
			);
			const finalMessage = canonicalAssistant(parts, selection, text);
			const orderedMessages = [...stepMessages, finalMessage];
			const canonicalMessages = orderedMessages.map((message, index) => ({
				id:
					index === orderedMessages.length - 1
						? input.assistantTurnId
						: crypto.randomUUID(),
				turnId: input.assistantTurnId,
				message,
				origin: "text" as const,
				status: "complete" as const,
			}));

			if (status === "error") {
				await chatV2Repository.appendCanonicalMessages(
					input.userId,
					input.conversationId,
					canonicalMessages,
				);
				await generationService.failGeneration(
					input.userId,
					generation.id,
					new Error(text),
				);
				return;
			}

			const completed = await generationService.completeGeneration(
				input.userId,
				generation.id,
				canonicalMessages,
				finalMessage.usage,
				finalMessage.stopReason,
			);
			if (completed)
				void enqueueAndRunCompaction(
					input.userId,
					input.conversationId,
					selection,
				).catch((error) =>
					logger
						.withError(error)
						.withMetadata({ conversationId: input.conversationId })
						.warn("chat-v2 compaction failed"),
				);
		},
	});
}

const FALLBACK_CONTEXT_WINDOW_TOKENS = 128_000;

/** Real per-model thresholds (admin-configured `contextPolicy`) when set;
 * otherwise a conservative default derived from the model's context window,
 * matching pi-agent-core's own harness defaults. */
async function resolveCompactionPolicy(
	selection: ModelSelection,
): Promise<CompactionTriggerPolicy> {
	if (selection.provider !== "mock") {
		const resolved = await resolveModel(selection);
		if (resolved.contextPolicy) {
			const policy = resolved.contextPolicy;
			return policy.enabled
				? {
						enabled: true,
						softTriggerTokens: policy.softTriggerTokens,
						targetTokens: policy.targetTokens,
					}
				: { enabled: false, softTriggerTokens: 0, targetTokens: 0 };
		}
	}
	const capabilities = await getModelCapabilities(selection);
	const contextWindow =
		capabilities.contextWindow ?? FALLBACK_CONTEXT_WINDOW_TOKENS;
	return {
		enabled: true,
		softTriggerTokens: Math.max(
			contextWindow - DEFAULT_COMPACTION_SETTINGS.reserveTokens,
			0,
		),
		targetTokens: DEFAULT_COMPACTION_SETTINGS.keepRecentTokens,
	};
}

/** Used only for the post-overflow retry path: compacts unconditionally
 * (ignoring the soft trigger) since the provider has already told us the
 * current history is too large, then rebuilds the outbound context from the
 * now-shorter history. */
async function forceCompactAndRebuildContext(
	userId: string,
	conversationId: string,
	selection: ModelSelection,
	systemPrompt: string | null,
) {
	const policy = await resolveCompactionPolicy(selection);
	const jobId = await enqueueCompactionForCompletedGeneration(
		chatV2Repository,
		userId,
		conversationId,
		{ enabled: true, softTriggerTokens: 0, targetTokens: policy.targetTokens },
	);
	if (jobId)
		await new CompactionService(chatV2Repository).run(
			userId,
			jobId,
			createV2Summarizer(selection),
		);
	return buildOutboundContext(userId, conversationId, selection, systemPrompt);
}

async function enqueueAndRunCompaction(
	userId: string,
	conversationId: string,
	selection: ModelSelection,
): Promise<void> {
	const policy = await resolveCompactionPolicy(selection);
	const jobId = await enqueueCompactionForCompletedGeneration(
		chatV2Repository,
		userId,
		conversationId,
		policy,
	);
	if (!jobId) return;
	await new CompactionService(chatV2Repository).run(
		userId,
		jobId,
		createV2Summarizer(selection),
	);
}

function canonicalAssistant(
	parts: unknown,
	selection: { provider: string; api: string; modelId: string },
	text: string,
): AssistantMessage {
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
		totalTokens:
			usage?.totalTokens ?? (usage?.input ?? 0) + (usage?.output ?? 0),
		cost: { ...defaults.cost, ...usage?.cost },
	};
}

interface HistoryToolCall {
	id: string;
	name: string;
	serverName?: string;
	remoteName?: string;
	args: string;
	status: "complete" | "error";
	output?: string;
}

/**
 * Rebuilds tool-call chips for a persisted turn from its canonical messages.
 * The live generation stream carries `serverName`/`remoteName` in-memory
 * only (see `adapter.ts`'s `toolDisplayNames`), so history reloaded from the
 * DB has to reconstruct call/result pairing from the raw `toolCall` and
 * `toolResult` message content instead.
 */
function extractTurnToolCalls(turn: VisibleTurn): HistoryToolCall[] {
	const resultsByCallId = new Map<string, { text: string; isError: boolean }>();
	for (const { message } of turn.messages) {
		if (message.role !== "toolResult") continue;
		const text = message.content
			.filter((content): content is TextContent => content.type === "text")
			.map((content) => content.text)
			.join("\n");
		resultsByCallId.set(message.toolCallId, { text, isError: message.isError });
	}
	const calls: HistoryToolCall[] = [];
	for (const { message } of turn.messages) {
		if (message.role !== "assistant") continue;
		for (const part of message.content) {
			if (part.type !== "toolCall") continue;
			const result = resultsByCallId.get(part.id);
			calls.push({
				id: part.id,
				name: part.name,
				args: JSON.stringify(part.arguments),
				status: result?.isError ? "error" : "complete",
				output: result?.text,
			});
		}
	}
	return calls;
}

export async function loadMessages(userId: string, conversationId: string) {
	const records = await chatV2Repository.listCanonicalMessages(
		userId,
		conversationId,
	);
	const attachmentsByMessageId = new Map<
		string,
		import("../chat-v2/types").AttachmentRecord[]
	>();
	for (const {
		messageId,
		attachment,
	} of await chatV2Repository.listMessageAttachments(userId, conversationId))
		attachmentsByMessageId.set(messageId, [
			...(attachmentsByMessageId.get(messageId) ?? []),
			attachment,
		]);
	await loadCanonicalHistory(chatV2Repository, userId, conversationId);
	const turns = projectVisibleTurns(records, attachmentsByMessageId);
	const turnToolCalls = turns.map(extractTurnToolCalls);
	const displayNames = await describeToolNames([
		...new Set(turnToolCalls.flat().map((call) => call.name)),
	]);
	return turns.map((turn, index) => ({
		id: turn.id,
		role: turn.role,
		text: turn.displayText,
		parts: JSON.stringify(turn.messages.at(-1)?.message ?? null),
		status: turn.status === "pending" ? "generating" : turn.status,
		createdAt: turn.messages[0]!.createdAt,
		reasoning: turn.reasoning.join("\n"),
		toolCalls: turnToolCalls[index]!.map((call) => ({
			...call,
			...displayNames.get(call.name),
		})),
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

export async function createConversation(input: {
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
