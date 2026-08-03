import type { ModelDescriptor, ModelSelection } from "../chat/catalog";
import { listAvailableModels, resolveSelection } from "../chat/catalog";
import { loadMessages } from "../chat/v2Live";
import type { ChatV2Repository } from "../chat-v2/db/repository";

export interface OpenWebUiChatSummary {
	id: string;
	title: string;
	created_at: number;
	updated_at: number;
	last_read_at: number | null;
	snippet: string;
	folder_id: string | null;
	pinned: boolean;
	archived: boolean;
}

function unixSeconds(iso: string): number {
	return Math.floor(Date.parse(iso) / 1000);
}

function parseParts(parts: string): Record<string, unknown> | null {
	try {
		const value = JSON.parse(parts) as unknown;
		return value && typeof value === "object"
			? (value as Record<string, unknown>)
			: null;
	} catch {
		return null;
	}
}

function modelIds(conversation: { modelId: string | null }): string[] {
	return conversation.modelId ? [conversation.modelId] : [];
}

export async function chatSummary(
	repository: ChatV2Repository,
	userId: string,
	conversation: Awaited<
		ReturnType<ChatV2Repository["listConversations"]>
	>[number],
): Promise<OpenWebUiChatSummary> {
	const messages = await repository.listCanonicalMessages(
		userId,
		conversation.id,
	);
	const snippet =
		messages
			.toReversed()
			.map((record) =>
				typeof record.message.content === "string"
					? record.message.content
					: record.message.content
							.filter((part) => part.type === "text")
							.map((part) => part.text)
							.join("\n"),
			)
			.find(Boolean) ?? "";
	return {
		id: conversation.id,
		title: conversation.title,
		created_at: unixSeconds(conversation.createdAt),
		updated_at: unixSeconds(conversation.updatedAt),
		last_read_at: null,
		snippet: snippet.slice(0, 500),
		folder_id: conversation.folderId,
		pinned: false,
		archived: false,
	};
}

export async function chatResponse(
	repository: ChatV2Repository,
	userId: string,
	conversationId: string,
) {
	const conversation = await repository.getConversation(userId, conversationId);
	const turns = await loadMessages(userId, conversationId);
	const messages: Record<string, Record<string, unknown>> = {};
	for (const [index, turn] of turns.entries()) {
		const parentId = index > 0 ? turns[index - 1]!.id : null;
		const childrenIds = turns[index + 1] ? [turns[index + 1]!.id] : [];
		const persisted = parseParts(turn.parts);
		const message: Record<string, unknown> = {
			id: turn.id,
			parentId,
			childrenIds,
			role: turn.role,
			content: turn.text,
			timestamp: unixSeconds(turn.createdAt),
			models: modelIds(conversation),
			done: !turn.isActive,
		};
		if (persisted?.usage) message.usage = persisted.usage;
		if (turn.reasoning) message.reasoning_content = turn.reasoning;
		if (turn.toolCalls.length) {
			message.tool_calls = turn.toolCalls.map((call) => ({
				id: call.id,
				type: "function",
				function: {
					name: call.remoteName ?? call.name,
					arguments: call.args,
				},
			}));
		}
		messages[turn.id] = message;
	}
	const currentId = turns.at(-1)?.id ?? null;
	const tagRecords = await repository.listTags(userId);
	const tagIds = new Set(
		(await repository.listConversations(userId)).find(
			(item) => item.id === conversationId,
		)?.tagIds ?? [],
	);
	const tags = tagRecords
		.filter((tag) => tagIds.has(tag.id))
		.map((tag) => ({ id: tag.id, name: tag.name }));
	const history = { currentId, messages };
	return {
		id: conversation.id,
		user_id: userId,
		title: conversation.title,
		chat: {
			id: conversation.id,
			title: conversation.title,
			models: modelIds(conversation),
			history,
			messages,
			tags,
			files: [],
			timestamp: unixSeconds(conversation.createdAt),
		},
		created_at: unixSeconds(conversation.createdAt),
		updated_at: unixSeconds(conversation.updatedAt),
		share_id: null,
		archived: false,
		pinned: false,
		meta: {},
		folder_id: conversation.folderId,
		tasks: null,
		summary: null,
	};
}

export function modelResponse(models: ModelDescriptor[]) {
	return {
		data: models.map((model) => ({
			id: model.modelId,
			name: model.name,
			owned_by: model.provider,
			created: 0,
			info: {
				id: model.modelId,
				name: model.name,
				meta: {
					capabilities: {
						vision: model.vision,
						reasoning: model.reasoning,
						file_upload: model.documents,
					},
				},
			},
			endpointId: model.endpointId,
			provider: model.provider,
			api: model.api,
			modelId: model.modelId,
		})),
	};
}

export async function resolveModelSelection(
	userId: string,
	isAdmin: boolean,
	input: Record<string, unknown>,
): Promise<ModelSelection> {
	const requestedModel = typeof input.model === "string" ? input.model : null;
	const modelItem =
		input.model_item && typeof input.model_item === "object"
			? (input.model_item as Record<string, unknown>)
			: {};
	const available = await listAvailableModels(isAdmin);
	const match = available.find((model) => {
		if (requestedModel && model.modelId === requestedModel) return true;
		return (
			model.provider === modelItem.provider &&
			model.endpointId === modelItem.endpointId &&
			model.modelId === modelItem.id &&
			model.api === modelItem.api
		);
	});
	if (match) return match;
	return resolveSelection(
		{
			provider:
				typeof modelItem.provider === "string" ? modelItem.provider : undefined,
			endpointId:
				typeof modelItem.endpointId === "string"
					? modelItem.endpointId
					: undefined,
			modelId: requestedModel ?? undefined,
			api: typeof modelItem.api === "string" ? modelItem.api : undefined,
		},
		userId,
		isAdmin,
	);
}

export function textFromContent(value: unknown): string {
	if (typeof value === "string") return value;
	if (!Array.isArray(value)) return "";
	return value
		.flatMap((part) =>
			part &&
			typeof part === "object" &&
			"text" in part &&
			typeof part.text === "string"
				? [part.text]
				: [],
		)
		.join("");
}
