import type { Message, StopReason, Usage } from "@earendil-works/pi-ai";

export const CANONICAL_MESSAGE_STATUSES = [
	"pending",
	"streaming",
	"complete",
	"stopped",
	"error",
] as const;
export type CanonicalMessageStatus =
	(typeof CANONICAL_MESSAGE_STATUSES)[number];

export const GENERATION_STATUSES = [
	"queued",
	"running",
	"complete",
	"stopped",
	"failed",
	"interrupted",
	// Pre-M4 values remain readable for existing persisted fixtures.
	"pending",
	"streaming",
	"error",
] as const;
export type GenerationStatus = (typeof GENERATION_STATUSES)[number];

export const CANONICAL_MESSAGE_ORIGINS = [
	"text",
	"voice",
	"legacy",
	"compaction",
] as const;
export type CanonicalMessageOrigin = (typeof CANONICAL_MESSAGE_ORIGINS)[number];

export type CanonicalMessageRole = Message["role"];
export type VisibleTurnRole = "user" | "assistant";
export type CompactionJobStatus =
	| "queued"
	| "running"
	| "complete"
	| "stale"
	| "failed";

export interface ConversationRecord {
	id: string;
	userId: string;
	title: string;
	folderId: string | null;
	provider: string | null;
	endpointId: string | null;
	modelId: string | null;
	modelApi: string | null;
	systemPrompt: string | null;
	generationConfig: Record<string, unknown>;
	createdAt: string;
	updatedAt: string;
}

/** A UI grouping; canonical message ordering is always `ordinal` on messages. */
export interface ConversationTurnRecord {
	id: string;
	conversationId: string;
	ordinal: number;
	role: VisibleTurnRole;
	origin: CanonicalMessageOrigin;
	status: CanonicalMessageStatus;
	createdAt: string;
}

export interface CanonicalMessageRecord {
	id: string;
	conversationId: string;
	turnId: string | null;
	ordinal: number;
	role: CanonicalMessageRole;
	message: Message;
	origin: CanonicalMessageOrigin;
	status: CanonicalMessageStatus;
	createdAt: string;
}

export interface AttachmentRecord {
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
	createdAt: string;
}

export interface MessageAttachmentRecord {
	messageId: string;
	attachmentId: string;
	ordinal: number;
}

export type AttachmentDecisionReason =
	| "included"
	| "omitted_by_budget"
	| "unsupported_by_model"
	| "unavailable"
	| "summarized";

export interface AttachmentDecision {
	messageId: string;
	attachmentId: string;
	decision: AttachmentDecisionReason;
}

export interface ConversationListRecord extends ConversationRecord {
	tagIds: string[];
}

export interface ContextManifest {
	conversationId: string;
	messageIds: string[];
	compactionIds: string[];
	attachmentDecisions: AttachmentDecision[];
	sourceHash: string;
}

export interface GenerationRecord {
	id: string;
	conversationId: string;
	turnId: string | null;
	status: GenerationStatus;
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

/** Realtime-only state; canonical pi-ai messages remain transcript-only. */
export interface VoiceMetadata {
	interrupted?: boolean;
	truncated?: boolean;
	interruptionReason?: string;
}

export interface VoiceTurnRecord {
	turnKey: string;
	conversationId: string;
	userTurnId: string;
	assistantTurnId: string;
	generationId: string;
	metadata: VoiceMetadata;
	createdAt: string;
}

export interface GenerationEventRecord {
	generationId: string;
	sequence: number;
	kind: string;
	payload: Record<string, unknown>;
	createdAt: string;
}

export interface ContextCompactionRecord {
	id: string;
	conversationId: string;
	firstMessageId: string;
	lastMessageId: string;
	replacementMessages: Message[];
	sourceHash: string;
	promptVersion: string;
	provider: string | null;
	api: string | null;
	model: string | null;
	tokensBefore: number | null;
	tokensAfter: number | null;
	createdAt: string;
}

export interface ContextCompactionJobRecord {
	id: string;
	conversationId: string;
	firstMessageId: string;
	lastMessageId: string;
	sourceHash: string;
	status: CompactionJobStatus;
	compactionId: string | null;
	errorMessage: string | null;
	createdAt: string;
	finishedAt: string | null;
}

export interface DiagnosticIds {
	conversationId?: string;
	turnId?: string;
	messageId?: string;
	generationId?: string;
	compactionId?: string;
	ordinal?: number;
}

export const PI_AI_VERSION = "0.80.10";
export const PI_AGENT_CORE_VERSION = "0.80.10";
