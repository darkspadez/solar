import { CompactionService } from "./compaction";
import type { ChatV2Repository } from "./db/repository";

const MIN_COMPACTION_MESSAGES = 2;
const RETAIN_LIVE_MESSAGES = 2;

/** Queues the oldest uncompacted prefix while retaining the latest exchange live. */
export async function enqueueCompactionForCompletedGeneration(
	repository: ChatV2Repository,
	userId: string,
	conversationId: string,
): Promise<string | null> {
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
	const last = messages.length - RETAIN_LIVE_MESSAGES - 1;
	if (last - first + 1 < MIN_COMPACTION_MESSAGES) return null;

	const job = await new CompactionService(repository).enqueue(userId, conversationId, {
		firstMessageId: messages[first]!.id,
		lastMessageId: messages[last]!.id,
	});
	return job.id;
}
