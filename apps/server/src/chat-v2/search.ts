import type { CanonicalMessageRecord } from "./types";
import { displayText } from "./projection";

export interface SearchTextRecord {
	messageId: string;
	conversationId: string;
	text: string;
}

/** Rebuildable, non-authoritative search projection derived from canonical payloads. */
export function rebuildSearchProjection(records: readonly CanonicalMessageRecord[]): SearchTextRecord[] {
	return records.map((record) => ({ messageId: record.id, conversationId: record.conversationId, text: displayText(record.message) }));
}

export function searchProjection(entries: readonly SearchTextRecord[], query: string): SearchTextRecord[] {
	const needle = query.toLocaleLowerCase();
	return entries.filter((entry) => entry.text.toLocaleLowerCase().includes(needle));
}
