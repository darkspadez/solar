import type { Message } from "@earendil-works/pi-ai";
import type { ChatV2Repository } from "./db/repository";

/** Loads canonical pi-ai payloads without Solar-specific context transformation. */
export async function loadCanonicalHistory(
	repository: ChatV2Repository,
	userId: string,
	conversationId: string,
): Promise<Message[]> {
	const records = await repository.listCanonicalMessages(userId, conversationId);
	return records.map((record) => record.message);
}
