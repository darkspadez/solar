import { Hono, type Context } from "hono";
import { db } from "../db";
import { listAvailableModels, type ModelSelection } from "../chat/catalog";
import { chatV2Repository, sendMessage } from "../chat/v2Live";
import { V2NotFoundError } from "../chat-v2/db/repository";
import { getLogLevel, logger } from "../logger";
import {
	chatResponse,
	chatSummary,
	modelResponse,
	resolveModelSelection,
	textFromContent,
} from "./adapter";
import {
	resolveOpenWebUiPrincipal,
	signInOpenWebUi,
	type OpenWebUiPrincipal,
} from "./auth";
import { OpenWebUiSocketGateway } from "./socket";

const MCP_ID_PREFIX = "server:mcp:";

function traceFacade(event: string, metadata: Record<string, unknown>) {
	const entry = logger.withMetadata({ component: "openwebui", ...metadata });
	if (getLogLevel() === "trace") entry.trace(event);
	else entry.info(`trace: ${event}`);
}

function normalizedPage(value: string | undefined): number {
	const page = Number(value ?? 1);
	return Number.isInteger(page) && page > 0 ? page : 1;
}

function normalizeMcpId(value: string): string {
	return value.replace(/^server:mcp:/, "").replace(/^mcp:/, "");
}

function openWebUiUser(user: OpenWebUiPrincipal) {
	return {
		id: user.id,
		name: user.name,
		email: user.email,
		role: user.role,
		profile_image_url: "/user.png",
	};
}

async function requireUser(c: Context): Promise<OpenWebUiPrincipal | Response> {
	const user = await resolveOpenWebUiPrincipal(c.req.raw.headers);
	traceFacade("facade authentication resolved", {
		path: c.req.path,
		method: c.req.method,
		authenticated: Boolean(user),
		userId: user?.id,
	});
	return user ?? c.json({ detail: "Not authenticated" }, 401);
}

async function parseBody(c: Context): Promise<Record<string, unknown>> {
	try {
		const value = await c.req.json();
		return value && typeof value === "object"
			? (value as Record<string, unknown>)
			: {};
	} catch {
		return {};
	}
}

async function authorizedMcpServers(userId: string) {
	return db
		.selectFrom("mcp_server")
		.leftJoin("user_mcp_server_preference", (join) =>
			join
				.onRef("user_mcp_server_preference.serverId", "=", "mcp_server.id")
				.on("user_mcp_server_preference.userId", "=", userId),
		)
		.select([
			"mcp_server.id",
			"mcp_server.userId",
			"mcp_server.name",
			"mcp_server.enabled",
			"user_mcp_server_preference.enabled as preferenceEnabled",
		])
		.where("mcp_server.enabled", "=", 1)
		.where((eb) =>
			eb.or([
				eb("mcp_server.userId", "is", null),
				eb("mcp_server.userId", "=", userId),
			]),
		)
		.orderBy("mcp_server.name", "asc")
		.execute();
}

function toolServerDto(server: {
	id: string;
	name: string;
	preferenceEnabled: number | null;
}) {
	return {
		id: `${MCP_ID_PREFIX}${server.id}`,
		user_id: `${MCP_ID_PREFIX}${server.id}`,
		name: server.name,
		meta: { description: `Solar MCP server: ${server.name}` },
		config: { enable: Boolean(server.preferenceEnabled ?? 1) },
	};
}

async function applyToolSelection(
	userId: string,
	conversationId: string,
	value: unknown,
): Promise<void> {
	if (!Array.isArray(value)) return;
	const selected = new Set(
		value.flatMap((entry) =>
			typeof entry === "string"
				? [normalizeMcpId(entry)]
				: entry &&
						typeof entry === "object" &&
						"id" in entry &&
						typeof entry.id === "string"
					? [normalizeMcpId(entry.id)]
					: [],
		),
	);
	const servers = await authorizedMcpServers(userId);
	for (const server of servers)
		await chatV2Repository.setConversationMcpServer(
			userId,
			conversationId,
			server.id,
			selected.has(server.id),
		);
	await chatV2Repository.setConversationAutoExecuteTools(
		userId,
		conversationId,
		selected.size > 0,
	);
}

function modelSelectionFromChat(
	chat: Record<string, unknown>,
): Record<string, unknown> {
	const models = Array.isArray(chat.models) ? chat.models : [];
	return {
		model:
			typeof models[0] === "string"
				? models[0]
				: typeof chat.model === "string"
					? chat.model
					: undefined,
		model_item: chat.model_item,
	};
}

async function createChat(
	user: OpenWebUiPrincipal,
	body: Record<string, unknown>,
): Promise<string> {
	const chat =
		body.chat && typeof body.chat === "object"
			? (body.chat as Record<string, unknown>)
			: {};
	const selection = await resolveModelSelection(
		user.id,
		user.isAdmin,
		modelSelectionFromChat(chat),
	);
	const id = typeof chat.id === "string" && chat.id ? chat.id : undefined;
	const folderId = typeof body.folder_id === "string" ? body.folder_id : null;
	const conversation = await chatV2Repository.createConversation(user.id, {
		id,
		title:
			typeof chat.title === "string" && chat.title.trim()
				? chat.title
				: "New conversation",
		folderId,
		provider: selection.provider,
		endpointId: selection.endpointId,
		modelId: selection.modelId,
		modelApi: selection.api,
		systemPrompt:
			typeof chat.systemPrompt === "string" ? chat.systemPrompt : null,
	});
	return conversation.id;
}

async function setConversationModel(
	user: OpenWebUiPrincipal,
	conversationId: string,
	selection: ModelSelection,
) {
	await chatV2Repository.setConversationModel(user.id, conversationId, {
		provider: selection.provider,
		endpointId: selection.endpointId,
		modelId: selection.modelId,
		modelApi: selection.api,
	});
}

export function createOpenWebUiRoutes(gateway: OpenWebUiSocketGateway) {
	const routes = new Hono();

	routes.get("/health", (c) => c.json({ status: true }));

	routes.get("/api/config", async (c) => {
		const user = await resolveOpenWebUiPrincipal(c.req.raw.headers);
		const models = await listAvailableModels(user?.isAdmin ?? false);
		return c.json({
			status: true,
			name: "Solar",
			version: "0.1.0",
			features: {
				enable_websocket: true,
				enable_direct_connections: false,
				enable_image_generation: false,
				enable_code_interpreter: false,
				enable_web_search: false,
				enable_tools: true,
			},
			default_models: models.map((model) => model.modelId),
			audio: { stt: false, tts: false },
			file: { max_count: 0, max_size: 0 },
			permissions: { chat: { controls: true } },
			...(user ? { user: openWebUiUser(user) } : {}),
		});
	});

	routes.post("/api/v1/auths/signin", async (c) => {
		const body = await parseBody(c);
		const email = typeof body.email === "string" ? body.email : "";
		const password = typeof body.password === "string" ? body.password : "";
		traceFacade("facade sign-in received", {
			emailProvided: Boolean(email),
			passwordProvided: Boolean(password),
		});
		const result = await signInOpenWebUi(email, password);
		traceFacade("facade sign-in responded", {
			success: Boolean(result),
			userId: result?.user.id,
		});
		return result
			? c.json({ token: result.token, user: openWebUiUser(result.user) })
			: c.json({ detail: "Invalid credentials" }, 401);
	});

	routes.get("/api/v1/auths/", async (c) => {
		const user = await requireUser(c);
		if (user instanceof Response) return user;
		return c.json(openWebUiUser(user));
	});

	routes.get("/api/models", async (c) => {
		const user = await requireUser(c);
		if (user instanceof Response) return user;
		return c.json(modelResponse(await listAvailableModels(user.isAdmin)));
	});

	routes.get("/api/v1/chats/", async (c) => {
		const user = await requireUser(c);
		if (user instanceof Response) return user;
		const page = normalizedPage(c.req.query("page"));
		const conversations = await chatV2Repository.listConversations(user.id);
		const pageSize = 50;
		const pageItems = conversations.slice(
			(page - 1) * pageSize,
			page * pageSize,
		);
		return c.json(
			await Promise.all(
				pageItems.map((conversation) =>
					chatSummary(chatV2Repository, user.id, conversation),
				),
			),
		);
	});

	routes.get("/api/v1/chats/list", async (c) => {
		const user = await requireUser(c);
		if (user instanceof Response) return user;
		const conversations = await chatV2Repository.listConversations(user.id);
		return c.json(
			await Promise.all(
				conversations.map((conversation) =>
					chatSummary(chatV2Repository, user.id, conversation),
				),
			),
		);
	});

	routes.get("/api/v1/chats/pinned", async (c) => {
		const user = await requireUser(c);
		if (user instanceof Response) return user;
		return c.json([]);
	});

	routes.get("/api/v1/chats/all/tags", async (c) => {
		const user = await requireUser(c);
		if (user instanceof Response) return user;
		return c.json(
			(await chatV2Repository.listTags(user.id)).map((tag) => ({
				id: tag.id,
				name: tag.name,
			})),
		);
	});

	routes.post("/api/v1/chats/new", async (c) => {
		const user = await requireUser(c);
		if (user instanceof Response) return user;
		try {
			const body = await parseBody(c);
			const conversationId = await createChat(user, body);
			return c.json(
				await chatResponse(chatV2Repository, user.id, conversationId),
			);
		} catch (error) {
			return c.json(
				{
					detail:
						error instanceof Error ? error.message : "Unable to create chat",
				},
				400,
			);
		}
	});

	routes.get("/api/v1/chats/:id/pinned", async (c) => {
		const user = await requireUser(c);
		if (user instanceof Response) return user;
		try {
			await chatV2Repository.getConversation(user.id, c.req.param("id"));
			return c.json(false);
		} catch {
			return c.json({ detail: "Chat not found" }, 404);
		}
	});

	routes.get("/api/v1/chats/:id/tags", async (c) => {
		const user = await requireUser(c);
		if (user instanceof Response) return user;
		try {
			const chat = await chatResponse(
				chatV2Repository,
				user.id,
				c.req.param("id"),
			);
			return c.json(chat.chat.tags);
		} catch {
			return c.json({ detail: "Chat not found" }, 404);
		}
	});

	routes.get("/api/v1/chats/:id/tools", async (c) => {
		const user = await requireUser(c);
		if (user instanceof Response) return user;
		try {
			const conversation = await chatV2Repository.getConversation(
				user.id,
				c.req.param("id"),
			);
			const bindings = await chatV2Repository.listConversationMcpServers(
				user.id,
				conversation.id,
			);
			const bindingById = new Map(
				bindings.map((binding) => [binding.serverId, binding.enabled]),
			);
			const servers = await authorizedMcpServers(user.id);
			return c.json({
				auto_execute: Boolean(conversation.autoExecuteTools),
				servers: servers.map((server) => ({
					...toolServerDto(server),
					enabled:
						bindingById.get(server.id) ??
						Boolean(server.preferenceEnabled ?? 1),
				})),
			});
		} catch {
			return c.json({ detail: "Chat not found" }, 404);
		}
	});

	routes.post("/api/v1/chats/:id/tools", async (c) => {
		const user = await requireUser(c);
		if (user instanceof Response) return user;
		const body = await parseBody(c);
		const rawId =
			typeof body.server_id === "string"
				? body.server_id
				: typeof body.id === "string"
					? body.id
					: "";
		const serverId = normalizeMcpId(rawId);
		const enabled = body.enabled !== false;
		const server = (await authorizedMcpServers(user.id)).find(
			(item) => item.id === serverId,
		);
		if (!server) return c.json({ detail: "Tool server not found" }, 404);
		try {
			await chatV2Repository.setConversationMcpServer(
				user.id,
				c.req.param("id"),
				serverId,
				enabled,
			);
			return c.json({ status: true });
		} catch {
			return c.json({ detail: "Chat not found" }, 404);
		}
	});

	routes.post("/api/v1/chats/:id/tools/auto-execute", async (c) => {
		const user = await requireUser(c);
		if (user instanceof Response) return user;
		const body = await parseBody(c);
		try {
			await chatV2Repository.setConversationAutoExecuteTools(
				user.id,
				c.req.param("id"),
				body.enabled !== false,
			);
			return c.json({ status: true });
		} catch {
			return c.json({ detail: "Chat not found" }, 404);
		}
	});

	routes.get("/api/v1/tools/", async (c) => {
		const user = await requireUser(c);
		if (user instanceof Response) return user;
		return c.json((await authorizedMcpServers(user.id)).map(toolServerDto));
	});

	routes.get("/api/v1/folders/", async (c) => {
		const user = await requireUser(c);
		if (user instanceof Response) return user;
		return c.json(
			(await chatV2Repository.listFolders(user.id)).map((folder) => ({
				id: folder.id,
				name: folder.name,
				parent_id: null,
				meta: {},
				is_expanded: true,
				unread_count: 0,
				created_at: Math.floor(Date.parse(folder.createdAt) / 1000),
				updated_at: Math.floor(Date.parse(folder.createdAt) / 1000),
			})),
		);
	});

	routes.get("/api/v1/folders/shared", async (c) => {
		const user = await requireUser(c);
		if (user instanceof Response) return user;
		return c.json([]);
	});

	routes.post("/api/v1/folders/", async (c) => {
		const user = await requireUser(c);
		if (user instanceof Response) return user;
		const body = await parseBody(c);
		const name = typeof body.name === "string" ? body.name.trim() : "";
		if (!name) return c.json({ detail: "Folder name is required" }, 400);
		const folder = await chatV2Repository.createFolder(user.id, { name });
		return c.json({
			id: folder.id,
			name: folder.name,
			parent_id: null,
			meta: {},
			is_expanded: true,
			created_at: Math.floor(Date.parse(folder.createdAt) / 1000),
			updated_at: Math.floor(Date.parse(folder.createdAt) / 1000),
		});
	});

	routes.get("/api/v1/folders/:id", async (c) => {
		const user = await requireUser(c);
		if (user instanceof Response) return user;
		const folder = (await chatV2Repository.listFolders(user.id)).find(
			(item) => item.id === c.req.param("id"),
		);
		if (!folder) return c.json({ detail: "Folder not found" }, 404);
		return c.json({
			id: folder.id,
			name: folder.name,
			parent_id: null,
			meta: {},
		});
	});

	routes.post("/api/v1/folders/:id/update", async (c) => {
		const user = await requireUser(c);
		if (user instanceof Response) return user;
		const body = await parseBody(c);
		const name = typeof body.name === "string" ? body.name.trim() : "";
		if (!name) return c.json({ detail: "Folder name is required" }, 400);
		try {
			await chatV2Repository.renameFolder(user.id, c.req.param("id"), name);
			return c.json({ id: c.req.param("id"), name, parent_id: null, meta: {} });
		} catch {
			return c.json({ detail: "Folder not found" }, 404);
		}
	});

	routes.post("/api/v1/folders/:id/update/parent", async (c) => {
		const user = await requireUser(c);
		if (user instanceof Response) return user;
		try {
			const folder = (await chatV2Repository.listFolders(user.id)).find(
				(item) => item.id === c.req.param("id"),
			);
			if (!folder) throw new V2NotFoundError("folder", c.req.param("id"));
			return c.json({
				id: folder.id,
				name: folder.name,
				parent_id: null,
				meta: {},
			});
		} catch {
			return c.json({ detail: "Folder not found" }, 404);
		}
	});

	routes.delete("/api/v1/folders/:id", async (c) => {
		const user = await requireUser(c);
		if (user instanceof Response) return user;
		try {
			await chatV2Repository.deleteFolder(user.id, c.req.param("id"));
			return c.json(true);
		} catch {
			return c.json({ detail: "Folder not found" }, 404);
		}
	});

	routes.post("/api/v1/chats/:id/folder", async (c) => {
		const user = await requireUser(c);
		if (user instanceof Response) return user;
		const body = await parseBody(c);
		const folderId = typeof body.folder_id === "string" ? body.folder_id : null;
		try {
			await chatV2Repository.setConversationFolder(
				user.id,
				c.req.param("id"),
				folderId,
			);
			return c.json(
				await chatResponse(chatV2Repository, user.id, c.req.param("id")),
			);
		} catch {
			return c.json({ detail: "Chat or folder not found" }, 404);
		}
	});

	routes.get("/api/v1/chats/:id", async (c) => {
		const user = await requireUser(c);
		if (user instanceof Response) return user;
		try {
			return c.json(
				await chatResponse(chatV2Repository, user.id, c.req.param("id")),
			);
		} catch {
			return c.json({ detail: "Chat not found" }, 404);
		}
	});

	routes.post("/api/v1/chats/:id", async (c) => {
		const user = await requireUser(c);
		if (user instanceof Response) return user;
		const body = await parseBody(c);
		const chat =
			body.chat && typeof body.chat === "object"
				? (body.chat as Record<string, unknown>)
				: body;
		try {
			if (typeof chat.title === "string")
				await chatV2Repository.renameConversation(
					user.id,
					c.req.param("id"),
					chat.title,
				);
			if ("folder_id" in body)
				await chatV2Repository.setConversationFolder(
					user.id,
					c.req.param("id"),
					typeof body.folder_id === "string" ? body.folder_id : null,
				);
			return c.json(
				await chatResponse(chatV2Repository, user.id, c.req.param("id")),
			);
		} catch {
			return c.json({ detail: "Chat not found" }, 404);
		}
	});

	routes.delete("/api/v1/chats/:id", async (c) => {
		const user = await requireUser(c);
		if (user instanceof Response) return user;
		try {
			await chatV2Repository.deleteConversation(user.id, c.req.param("id"));
			return c.json(true);
		} catch {
			return c.json({ detail: "Chat not found" }, 404);
		}
	});

	routes.get("/api/tasks/chat/:id", async (c) => {
		const user = await requireUser(c);
		if (user instanceof Response) return user;
		const chatId = c.req.param("id");
		const taskIds = gateway.taskIds(user.id, chatId);
		if (taskIds.length) return c.json({ task_ids: taskIds });
		try {
			await chatV2Repository.getConversation(user.id, chatId);
		} catch {
			traceFacade("facade task poll for client-created chat", {
				userId: user.id,
				chatId,
			});
		}
		return c.json({ task_ids: [] });
	});

	routes.post("/api/tasks/chat/:id/stop", async (c) => {
		const user = await requireUser(c);
		if (user instanceof Response) return user;
		const stopped = await gateway.stopTasks(user.id, c.req.param("id"));
		traceFacade("facade chat task stop responded", {
			userId: user.id,
			chatId: c.req.param("id"),
			stopped,
		});
		return c.json({
			status: true,
			message: stopped ? "Task stopped" : "No active task",
		});
	});

	routes.post("/api/tasks/stop/:id", async (c) => {
		const user = await requireUser(c);
		if (user instanceof Response) return user;
		const stopped = await gateway.stopTask(user.id, c.req.param("id"));
		return c.json({
			status: stopped,
			message: stopped ? "Task stopped" : "No active task",
		});
	});

	routes.post("/api/chat/stop", async (c) => {
		const user = await requireUser(c);
		if (user instanceof Response) return user;
		const body = await parseBody(c);
		const messageId = [body.messageId, body.task_id, body.id].find(
			(value): value is string => typeof value === "string" && value.length > 0,
		);
		const stopped = messageId
			? await gateway.stopTask(user.id, messageId)
			: false;
		return c.json({ stopped });
	});

	routes.post("/api/chat/completions", async (c) => {
		const user = await requireUser(c);
		if (user instanceof Response) return user;
		const body = await parseBody(c);
		const userMessage =
			body.user_message && typeof body.user_message === "object"
				? (body.user_message as Record<string, unknown>)
				: null;
		const parentMessage =
			body.parent_message && typeof body.parent_message === "object"
				? (body.parent_message as Record<string, unknown>)
				: null;
		const messages = Array.isArray(body.messages) ? body.messages : [];
		const lastMessage = messages.at(-1);
		const text = textFromContent(
			userMessage?.content ??
				parentMessage?.content ??
				(lastMessage && typeof lastMessage === "object"
					? (lastMessage as Record<string, unknown>).content
					: ""),
		);
		traceFacade("facade completion received", {
			userId: user.id,
			requestedChatId: typeof body.chat_id === "string" ? body.chat_id : null,
			requestedModel: typeof body.model === "string" ? body.model : null,
			stream: body.stream === true,
			sessionIdProvided: typeof body.session_id === "string",
			toolServerCount: Array.isArray(body.tool_servers)
				? body.tool_servers.length
				: null,
			userMessageProvided: Boolean(userMessage),
			parentMessageProvided: Boolean(parentMessage),
			messageCount: messages.length,
			bodyKeys: Object.keys(body).sort(),
			messageLength: text.length,
		});
		try {
			const requestedChatId =
				typeof body.chat_id === "string" ? body.chat_id : null;
			let conversationId = requestedChatId;
			if (!conversationId)
				conversationId = await createChat(user, { chat: body });
			else {
				try {
					await chatV2Repository.getConversation(user.id, conversationId);
				} catch {
					conversationId = await createChat(user, {
						chat: {
							id: conversationId,
							title: "New conversation",
							models: [body.model],
						},
					});
				}
			}
			const selection = await resolveModelSelection(
				user.id,
				user.isAdmin,
				body,
			);
			await setConversationModel(user, conversationId, selection);
			await applyToolSelection(user.id, conversationId, body.tool_servers);
			if (!text.trim())
				return c.json({ detail: "A user message is required" }, 400);
			const messageId = await sendMessage({
				userId: user.id,
				isAdmin: user.isAdmin,
				conversationId,
				text,
			});
			gateway.attachTask({
				userId: user.id,
				chatId: conversationId,
				messageId,
				socketId:
					typeof body.session_id === "string" ? body.session_id : undefined,
			});
			traceFacade("facade completion responded", {
				userId: user.id,
				chatId: conversationId,
				messageId,
				model: selection.modelId,
			});
			return c.json({
				status: true,
				task_ids: [messageId],
				chat_id: conversationId,
			});
		} catch (error) {
			logger
				.withError(error)
				.withMetadata({ component: "openwebui", userId: user.id })
				.error("facade completion failed");
			return c.json(
				{
					detail:
						error instanceof Error
							? error.message
							: "Unable to start completion",
				},
				400,
			);
		}
	});

	return routes;
}
