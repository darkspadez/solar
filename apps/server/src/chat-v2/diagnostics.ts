import type { Kysely } from "kysely";
import type { Database } from "../db/schema";

export interface ChatV2OperationalDiagnostics {
	failedGenerations: Array<{ id: string; conversationId: string; userId: string; errorMessage: string | null; finishedAt: string | null }>;
	staleCompactionJobs: Array<{ id: string; conversationId: string; userId: string; errorMessage: string | null; finishedAt: string | null }>;
}

/** Query-only operational view; omit userId for the global admin view. */
export async function listChatV2OperationalDiagnostics(
	db: Kysely<Database>,
	userId?: string,
): Promise<ChatV2OperationalDiagnostics> {
	let failed = db.selectFrom("v2_generation as generation").innerJoin("v2_conversation as conversation", "conversation.id", "generation.conversationId").select(["generation.id", "generation.conversationId", "conversation.userId", "generation.errorMessage", "generation.finishedAt"]).where("generation.status", "=", "failed");
	let stale = db.selectFrom("v2_context_compaction_job as job").innerJoin("v2_conversation as conversation", "conversation.id", "job.conversationId").select(["job.id", "job.conversationId", "conversation.userId", "job.errorMessage", "job.finishedAt"]).where("job.status", "=", "stale");
	if (userId) {
		failed = failed.where("conversation.userId", "=", userId);
		stale = stale.where("conversation.userId", "=", userId);
	}
	const [failedGenerations, staleCompactionJobs] = await Promise.all([failed.orderBy("generation.finishedAt", "desc").execute(), stale.orderBy("job.finishedAt", "desc").execute()]);
	return { failedGenerations, staleCompactionJobs };
}
