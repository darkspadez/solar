import { sql, type Kysely } from "kysely";
import type { Database } from "../db/schema";
import { parseCanonicalMessage, validateMessageSequence } from "./validation";

export interface ChatV2IntegrityReport {
	integrity: string[];
	foreignKeyViolations: Record<string, unknown>[];
	messageValidationErrors: string[];
}

/** Runs SQLite checks plus canonical message and tool-pair validation without mutation. */
export async function checkChatV2Integrity(
	db: Kysely<Database>,
	scope: { conversationId?: string } = {},
): Promise<ChatV2IntegrityReport> {
	const [integrity, foreignKeys] = await Promise.all([
		sql<{ integrity_check: string }>`PRAGMA integrity_check`.execute(db),
		sql<Record<string, unknown>>`PRAGMA foreign_key_check`.execute(db),
	]);
	let query = db.selectFrom("v2_conversation_message").selectAll().orderBy("conversationId").orderBy("ordinal");
	if (scope.conversationId) query = query.where("conversationId", "=", scope.conversationId);
	const rows = await query.execute();
	const errors: string[] = [];
	for (const [conversationId, messages] of Map.groupBy(rows, (row) => row.conversationId)) {
		try {
			const parsed = messages.map((row) => {
				let payload: unknown;
				try {
					payload = JSON.parse(row.messageJson);
				} catch {
					throw new Error(`message ${row.id} has invalid JSON`);
				}
				const message = parseCanonicalMessage(payload, { conversationId, messageId: row.id, turnId: row.turnId ?? undefined, ordinal: row.ordinal });
				if (message.role !== row.role) throw new Error(`message ${row.id} role does not match row role`);
				return message;
			});
			validateMessageSequence(parsed, messages.map((row) => ({ conversationId, messageId: row.id, turnId: row.turnId ?? undefined, ordinal: row.ordinal })));
		} catch (error) {
			errors.push(error instanceof Error ? error.message : String(error));
		}
	}
	return { integrity: integrity.rows.map((row) => row.integrity_check), foreignKeyViolations: foreignKeys.rows, messageValidationErrors: errors };
}
