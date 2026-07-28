import type { Message, StopReason, Usage } from "@earendil-works/pi-ai";
import type { CanonicalMessageInput, ChatV2Repository } from "./db/repository";
import type { ContextManifest, GenerationRecord, GenerationStatus } from "./types";

export interface StartGenerationInput {
	userId: string;
	conversationId: string;
	turnId?: string | null;
	id?: string;
	provider: string;
	api: string;
	model: string;
	request: Record<string, unknown>;
	contextManifest?: ContextManifest;
	status?: "queued" | "running";
}

export interface GenerationCheckpoint {
	message: Message;
}

export interface GenerationLifecycleEvent {
	generationId: string;
	kind: "started" | "checkpoint" | "complete" | "stopped" | "failed" | "interrupted";
}

export type GenerationSubscriber = (event: GenerationLifecycleEvent) => void;

function parseJson(value: string | null): Record<string, unknown> | null {
	return value ? (JSON.parse(value) as Record<string, unknown>) : null;
}

function toGenerationRecord(record: Awaited<ReturnType<ChatV2Repository["getGeneration"]>>): GenerationRecord {
	return {
		id: record.id,
		conversationId: record.conversationId,
		turnId: record.turnId,
		status: record.status as GenerationStatus,
		provider: record.provider,
		api: record.api,
		model: record.model,
		request: parseJson(record.requestJson) ?? {},
		contextManifest: record.contextManifestJson ? JSON.parse(record.contextManifestJson) as ContextManifest : null,
		partialMessage: record.partialMessageJson ? JSON.parse(record.partialMessageJson) as Message : null,
		usage: record.usageJson ? JSON.parse(record.usageJson) as Usage : null,
		stopReason: record.stopReason as StopReason | null,
		errorMessage: record.errorMessage,
		startedAt: record.startedAt,
		finishedAt: record.finishedAt,
		createdAt: record.createdAt,
	};
}

/** Durable lifecycle operations; subscribers are optional transport adapters. */
export class GenerationService {
	private readonly subscribers = new Set<GenerationSubscriber>();

	constructor(private readonly repository: ChatV2Repository) {}

	subscribe(subscriber: GenerationSubscriber): () => void {
		this.subscribers.add(subscriber);
		return () => this.subscribers.delete(subscriber);
	}

	async startGeneration(input: StartGenerationInput): Promise<GenerationRecord> {
		const status = input.status ?? "running";
		const generation = await this.repository.createGeneration(input.userId, input.conversationId, {
			id: input.id,
			turnId: input.turnId,
			status,
			provider: input.provider,
			api: input.api,
			model: input.model,
			requestJson: JSON.stringify(input.request),
		});
		if (input.contextManifest)
			await this.repository.recordGenerationContextManifest(input.userId, generation.id, input.contextManifest);
		const result = toGenerationRecord(await this.repository.getGeneration(input.userId, generation.id));
		this.publish({ generationId: result.id, kind: "started" });
		return result;
	}

	async appendGenerationCheckpoint(userId: string, generationId: string, checkpoint: GenerationCheckpoint): Promise<boolean> {
		const appended = await this.repository.appendGenerationCheckpoint(userId, generationId, checkpoint);
		if (appended) this.publish({ generationId, kind: "checkpoint" });
		return appended;
	}

	async completeGeneration(userId: string, generationId: string, messages: readonly CanonicalMessageInput[], usage: Usage, stopReason: StopReason): Promise<boolean> {
		const completed = await this.repository.completeGeneration(userId, generationId, { messages, usage, stopReason });
		if (completed) this.publish({ generationId, kind: "complete" });
		return completed;
	}

	async stopGeneration(userId: string, generationId: string): Promise<boolean> {
		const stopped = await this.repository.stopGeneration(userId, generationId);
		if (stopped) this.publish({ generationId, kind: "stopped" });
		return stopped;
	}

	async failGeneration(userId: string, generationId: string, error: Error): Promise<boolean> {
		const failed = await this.repository.failGeneration(userId, generationId, error.message);
		if (failed) this.publish({ generationId, kind: "failed" });
		return failed;
	}

	async reconcileRunningGenerations(userId: string): Promise<number> {
		const count = await this.repository.reconcileRunningGenerations(userId);
		return count;
	}

	private publish(event: GenerationLifecycleEvent): void {
		for (const subscriber of this.subscribers) subscriber(event);
	}
}
