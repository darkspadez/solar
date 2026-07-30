import { estimateTokens } from "@earendil-works/pi-agent-core";
import type { CanonicalMessageRecord } from "./types";
import { CompactionService } from "./compaction";
import { findSafeCompactionRange } from "./context";
import type { ChatV2Repository } from "./db/repository";
const MIN_COMPACTION_MESSAGES = 2;
/** Always keep the most recent exchange live regardless of token budget. */
const RETAIN_LIVE_MESSAGES = 2;

export interface CompactionTriggerPolicy {
	enabled: boolean;
	/** Trigger compaction once uncompacted history exceeds this many tokens. */
	softTriggerTokens: number;
	/** Compact down to roughly this many live tokens. */
	targetTokens: number;
}

function sumTokens(messages: readonly CanonicalMessageRecord[]): number {
	return messages.reduce(
		// biome-ignore lint/suspicious/noExplicitAny: pi-agent-core's AgentMessage is a superset of pi-ai's Message
		(total, record) => total + estimateTokens(record.message as any),
		0,
	);
}

/**
 * Queues the oldest uncompacted prefix once real (estimated) token usage
 * exceeds the model's configured soft trigger, retaining as much recent
 * history as fits under the target budget.
 */
export async function enqueueCompactionForCompletedGeneration(
	repository: ChatV2Repository,
	userId: string,
	conversationId: string,
	policy: CompactionTriggerPolicy,
): Promise<string | null> {
	if (!policy.enabled) return null;
	const [messages, compactions, jobs] = await Promise.all([
		repository.listCanonicalMessages(userId, conversationId),
		repository.listCompactions(userId, conversationId),
		repository.listCompactionJobs(userId, conversationId),
	]);
	if (jobs.some((job) => job.status === "queued" || job.status === "running"))
		return null;

	const compactedThrough = compactions.reduce(
		(last, compaction) =>
			Math.max(
				last,
				messages.findIndex((message) => message.id === compaction.lastMessageId),
			),
		-1,
	);
	const first = compactedThrough + 1;
	if (messages.length - first < MIN_COMPACTION_MESSAGES) return null;

	const totalTokens = sumTokens(messages.slice(first));
	if (totalTokens <= policy.softTriggerTokens) return null;

	// Keep the final RETAIN_LIVE_MESSAGES live no matter what, then extend the
	// live tail further back while it still fits under the target budget.
	let boundary = Math.max(messages.length - RETAIN_LIVE_MESSAGES, first);
	let liveTokens = sumTokens(messages.slice(boundary));
	while (boundary - 1 > first) {
		const next = estimateTokens(
			// biome-ignore lint/suspicious/noExplicitAny: pi-agent-core's AgentMessage is a superset of pi-ai's Message
			messages[boundary - 1]!.message as any,
		);
		if (liveTokens + next > policy.targetTokens) break;
		liveTokens += next;
		boundary--;
	}
	const candidateLast = boundary - 1;
	const safeRange = findSafeCompactionRange(messages, first, candidateLast);
	if (
		!safeRange ||
		safeRange.lastIndex - safeRange.firstIndex + 1 < MIN_COMPACTION_MESSAGES
	)
		return null;

	const job = await new CompactionService(repository).enqueue(
		userId,
		conversationId,
		{
			firstMessageId: messages[safeRange.firstIndex]!.id,
			lastMessageId: messages[safeRange.lastIndex]!.id,
		},
	);
	return job.id;
}
