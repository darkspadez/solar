import { createHash } from "node:crypto";
import type { Message } from "@earendil-works/pi-ai";
import type {
	CanonicalMessageRecord,
	ContextCompactionRecord,
	ContextManifest,
	AttachmentDecision,
} from "./types";
import {
	expandMessageAttachments,
	type AttachmentExpansionInput,
} from "./attachments";
import { validateMessageSequence } from "./validation";

export class CompactionSelectionError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "CompactionSelectionError";
	}
}

export interface SelectedCompaction extends ContextCompactionRecord {
	firstIndex: number;
	lastIndex: number;
}

function canonicalJson(value: unknown): string {
	if (value === null || typeof value !== "object") return JSON.stringify(value);
	if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
	const record = value as Record<string, unknown>;
	return `{${Object.keys(record)
		.sort()
		.map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
		.join(",")}}`;
}

/** Hashes exact source identities and payloads independently of object key insertion order. */
export function sourceHash(records: readonly CanonicalMessageRecord[]): string {
	return createHash("sha256")
		.update(canonicalJson(records.map(({ id, message }) => ({ id, message }))))
		.digest("hex");
}

function rangeFor(
	messages: readonly CanonicalMessageRecord[],
	firstMessageId: string,
	lastMessageId: string,
): {
	firstIndex: number;
	lastIndex: number;
	records: CanonicalMessageRecord[];
} | null {
	const firstIndex = messages.findIndex(
		(message) => message.id === firstMessageId,
	);
	const lastIndex = messages.findIndex(
		(message) => message.id === lastMessageId,
	);
	if (firstIndex < 0 || lastIndex < firstIndex) return null;
	return {
		firstIndex,
		lastIndex,
		records: messages.slice(firstIndex, lastIndex + 1),
	};
}

/** A range may not put either end of an assistant tool transaction outside it. */
export function assertSafeCompactionRange(
	messages: readonly CanonicalMessageRecord[],
	firstMessageId: string,
	lastMessageId: string,
): void {
	const range = rangeFor(messages, firstMessageId, lastMessageId);
	if (!range)
		throw new CompactionSelectionError(
			"compaction range is not contiguous canonical history",
		);
	validateMessageSequence(messages.map((record) => record.message));
	const callIndexes = new Map<string, number>();
	const resultIndexes = new Map<string, number>();
	for (const [index, record] of messages.entries()) {
		if (record.message.role === "assistant") {
			for (const part of record.message.content)
				if (part.type === "toolCall") callIndexes.set(part.id, index);
		} else if (record.message.role === "toolResult")
			resultIndexes.set(record.message.toolCallId, index);
	}
	for (const [toolCallId, callIndex] of callIndexes) {
		const resultIndex = resultIndexes.get(toolCallId)!;
		const includesCall =
			callIndex >= range.firstIndex && callIndex <= range.lastIndex;
		const includesResult =
			resultIndex >= range.firstIndex && resultIndex <= range.lastIndex;
		if (includesCall !== includesResult)
			throw new CompactionSelectionError(
				`compaction range splits tool call ${toolCallId} from its result`,
			);
	}
}
/**
 * Given canonical messages, a starting index, and a candidate ending index,
 * adjusts the range so it never splits an assistant tool call from its result.
 * Returns null if no valid non-empty range exists within candidate bounds.
 */
export function findSafeCompactionRange(
	messages: readonly CanonicalMessageRecord[],
	firstIndex: number,
	candidateLastIndex: number,
): { firstIndex: number; lastIndex: number } | null {
	if (
		firstIndex < 0 ||
		candidateLastIndex < firstIndex ||
		candidateLastIndex >= messages.length
	)
		return null;

	const callIndexes = new Map<string, number>();
	const resultIndexes = new Map<string, number>();
	for (const [index, record] of messages.entries()) {
		if (record.message.role === "assistant") {
			for (const part of record.message.content)
				if (part.type === "toolCall") callIndexes.set(part.id, index);
		} else if (record.message.role === "toolResult")
			resultIndexes.set(record.message.toolCallId, index);
	}

	let last = candidateLastIndex;
	let first = firstIndex;

	let adjusted = true;
	while (adjusted) {
		adjusted = false;
		for (const [toolCallId, callIndex] of callIndexes) {
			const resultIndex = resultIndexes.get(toolCallId);
			if (resultIndex === undefined) continue;

			const includesCall = callIndex >= first && callIndex <= last;
			const includesResult = resultIndex >= first && resultIndex <= last;

			if (includesCall && !includesResult) {
				last = callIndex - 1;
				adjusted = true;
				break;
			} else if (!includesCall && includesResult) {
				first = resultIndex + 1;
				adjusted = true;
				break;
			}
		}
	}

	if (last < first) return null;

	return { firstIndex: first, lastIndex: last };
}

/** Selects current artifacts only; stale source hashes are ignored, ambiguous overlaps fail. */
export function selectValidCompactions(
	messages: readonly CanonicalMessageRecord[],
	artifacts: readonly ContextCompactionRecord[],
): SelectedCompaction[] {
	const selected: SelectedCompaction[] = [];
	for (const artifact of artifacts) {
		const range = rangeFor(
			messages,
			artifact.firstMessageId,
			artifact.lastMessageId,
		);
		if (!range || sourceHash(range.records) !== artifact.sourceHash) continue;
		assertSafeCompactionRange(
			messages,
			artifact.firstMessageId,
			artifact.lastMessageId,
		);
		validateMessageSequence(artifact.replacementMessages);
		selected.push({
			...artifact,
			firstIndex: range.firstIndex,
			lastIndex: range.lastIndex,
		});
	}
	selected.sort(
		(left, right) =>
			left.firstIndex - right.firstIndex || left.lastIndex - right.lastIndex,
	);
	for (const [index, compaction] of selected.entries()) {
		const previous = selected[index - 1];
		if (previous && compaction.firstIndex <= previous.lastIndex)
			throw new CompactionSelectionError(
				`compactions ${previous.id} and ${compaction.id} overlap ambiguously`,
			);
	}
	return selected;
}

/** Returns a derived sequence; canonical records and messages are never mutated. */
export function substituteCompactionRanges(
	messages: readonly CanonicalMessageRecord[],
	compactions: readonly SelectedCompaction[],
): Message[] {
	const byFirstIndex = new Map(
		compactions.map((compaction) => [compaction.firstIndex, compaction]),
	);
	const result: Message[] = [];
	for (let index = 0; index < messages.length; index += 1) {
		const compaction = byFirstIndex.get(index);
		if (compaction) {
			result.push(...compaction.replacementMessages);
			index = compaction.lastIndex;
		} else result.push(messages[index]!.message);
	}
	return result;
}

export function materializeContext(
	conversationId: string,
	messages: readonly CanonicalMessageRecord[],
	artifacts: readonly ContextCompactionRecord[],
	attachmentExpansion?: AttachmentExpansionInput,
): { context: Message[]; manifest: ContextManifest } {
	const compactions = selectValidCompactions(messages, artifacts);
	const covered = new Set<number>();
	for (const compaction of compactions)
		for (
			let index = compaction.firstIndex;
			index <= compaction.lastIndex;
			index += 1
		)
			covered.add(index);
	const attachmentDecisions: AttachmentDecision[] = [];
	const expandedMessages = attachmentExpansion
		? messages.map((message, index) => {
				if (covered.has(index)) return message;
				const expanded = expandMessageAttachments(
					message,
					attachmentExpansion.attachmentsByMessageId.get(message.id) ?? [],
					attachmentExpansion.capabilities,
					attachmentExpansion.resolve,
				);
				attachmentDecisions.push(...expanded.decisions);
				return { ...message, message: expanded.message };
			})
		: messages;
	return {
		context: substituteCompactionRanges(expandedMessages, compactions),
		manifest: {
			conversationId,
			messageIds: messages
				.filter((_, index) => !covered.has(index))
				.map((message) => message.id),
			compactionIds: compactions.map((compaction) => compaction.id),
			attachmentDecisions,
			sourceHash: sourceHash(messages),
		},
	};
}
