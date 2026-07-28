import {
	convertToLlm,
	createCompactionSummaryMessage,
	estimateTokens,
} from "@earendil-works/pi-agent-core";
import type { Message } from "@earendil-works/pi-ai";
import { assertSafeCompactionRange, sourceHash } from "./context";
import type { ChatV2Repository } from "./db/repository";
import type {
	ContextCompactionJobRecord,
	ContextCompactionRecord,
} from "./types";

export interface CompactionRange {
	firstMessageId: string;
	lastMessageId: string;
}

export interface SummarizerInput {
	messages: Message[];
	tokensBefore: number;
}

export type CompactionSummarizer = (input: SummarizerInput) => Promise<string>;

export class CompactionService {
	constructor(private readonly repository: ChatV2Repository) {}

	async enqueue(
		userId: string,
		conversationId: string,
		range: CompactionRange,
	): Promise<ContextCompactionJobRecord> {
		const messages = await this.repository.listCanonicalMessages(
			userId,
			conversationId,
		);
		assertSafeCompactionRange(
			messages,
			range.firstMessageId,
			range.lastMessageId,
		);
		const first = messages.findIndex(
			(message) => message.id === range.firstMessageId,
		);
		const last = messages.findIndex(
			(message) => message.id === range.lastMessageId,
		);
		return this.repository.enqueueCompactionJob(userId, conversationId, {
			...range,
			sourceHash: sourceHash(messages.slice(first, last + 1)),
		});
	}

	async run(
		userId: string,
		jobId: string,
		summarize: CompactionSummarizer,
	): Promise<ContextCompactionRecord | "stale"> {
		const job = await this.repository.startCompactionJob(userId, jobId);
		try {
			const messages = await this.repository.listCanonicalMessages(
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
			)
				return this.repository.markCompactionJobStale(userId, jobId);
		const source = messages.slice(first, last + 1);
		const tokensBefore = source.reduce(
			// biome-ignore lint/suspicious/noExplicitAny: pi-agent-core's AgentMessage is a superset of pi-ai's Message
			(total, message) => total + estimateTokens(message.message as any),
			0,
		);
		const summary = await summarize({
			messages: source.map((message) => message.message),
			tokensBefore,
		});
		const replacementMessages = convertToLlm([
			createCompactionSummaryMessage(
				summary,
				tokensBefore,
				new Date().toISOString(),
			),
		]);
		const tokensAfter = Math.ceil(summary.length / 4);
		return this.repository.materializeCompactionJob(userId, jobId, {
			replacementMessages,
			promptVersion: "v1",
			tokensBefore,
			tokensAfter,
		});
		} catch (error) {
			await this.repository.failCompactionJob(
				userId,
				jobId,
				error instanceof Error ? error.message : String(error),
			);
			throw error;
		}
	}
}
