import type { Generated } from "kysely";

export interface V2ConversationTable {
	id: string;
	userId: string;
	title: string;
	folderId: string | null;
	provider: string | null;
	endpointId: string | null;
	modelId: string | null;
	modelApi: string | null;
	systemPrompt: string | null;
	generationConfigJson: Generated<string>;
	reasoningEffort: string | null;
	reasoningSummary: Generated<number>;
	verbosity: string | null;
	autoExecuteTools: Generated<number>;
	displayMode: string | null;
	createdAt: Generated<string>;
	updatedAt: Generated<string>;
}

export interface V2ConversationMcpServerTable {
	conversationId: string;
	serverId: string;
	enabled: Generated<number>;
}

export interface V2FolderTable {
	id: string;
	userId: string;
	name: string;
	createdAt: Generated<string>;
}

export interface V2TagTable {
	id: string;
	userId: string;
	name: string;
	createdAt: Generated<string>;
}

export interface V2ConversationTagTable {
	conversationId: string;
	tagId: string;
}

export interface V2ConversationTurnTable {
	id: string;
	conversationId: string;
	ordinal: number;
	role: "user" | "assistant";
	origin: string;
	status: string;
	createdAt: Generated<string>;
}

export interface V2ConversationMessageTable {
	id: string;
	conversationId: string;
	turnId: string | null;
	ordinal: number;
	role: "user" | "assistant" | "toolResult";
	messageJson: string;
	origin: string;
	status: string;
	createdAt: Generated<string>;
}

export interface V2AttachmentTable {
	id: string;
	userId: string;
	storageKey: string;
	filename: string;
	mimeType: string;
	kind: string;
	byteSize: number;
	sha256: string;
	width: number | null;
	height: number | null;
	pageCount: number | null;
	createdAt: Generated<string>;
}

export interface V2MessageAttachmentTable {
	messageId: string;
	attachmentId: string;
	ordinal: number;
}

export interface V2GenerationTable {
	id: string;
	conversationId: string;
	turnId: string | null;
	status: string;
	provider: string;
	api: string;
	model: string;
	requestJson: string;
	contextManifestJson: string | null;
	partialMessageJson: string | null;
	usageJson: string | null;
	stopReason: string | null;
	errorMessage: string | null;
	startedAt: string | null;
	finishedAt: string | null;
	createdAt: Generated<string>;
}

export interface V2GenerationEventTable {
	generationId: string;
	sequence: number;
	kind: string;
	payloadJson: string;
	createdAt: Generated<string>;
}

export interface V2VoiceTurnTable {
	turnKey: string;
	conversationId: string;
	userTurnId: string;
	assistantTurnId: string;
	generationId: string;
	metadataJson: string;
	createdAt: Generated<string>;
}

export interface V2ContextCompactionTable {
	id: string;
	conversationId: string;
	firstMessageId: string;
	lastMessageId: string;
	replacementMessagesJson: string;
	sourceHash: string;
	promptVersion: string;
	provider: string | null;
	api: string | null;
	model: string | null;
	tokensBefore: number | null;
	tokensAfter: number | null;
	createdAt: Generated<string>;
}

export interface V2ContextCompactionJobTable {
	id: string;
	conversationId: string;
	firstMessageId: string;
	lastMessageId: string;
	sourceHash: string;
	status: string;
	compactionId: string | null;
	errorMessage: string | null;
	createdAt: Generated<string>;
	finishedAt: string | null;
}
