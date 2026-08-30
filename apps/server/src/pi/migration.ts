/**
 * chat-v2 → pi session import (plan: Import of existing chats).
 *
 * `importConversation(conversationId)` is idempotent and safe to call
 * unconditionally: it no-ops when a completed pi session file already exists
 * for the ID, creates an empty session for conversations with no history, and
 * otherwise replays chat-v2's canonical record into a pi session written in a
 * temp directory and renamed into place (so concurrent readers only ever see
 * "not migrated" or "fully migrated").
 *
 * Migration status has no DB flag (plan: Core principle) — file existence is
 * the check, via isPiSessionReady().
 */
import { randomUUID } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	readdirSync,
	renameSync,
	rmSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { Message } from "@earendil-works/pi-ai";
import { chatV2Repository } from "../chat-v2/db/repository";
import type { CanonicalMessageRecord } from "../chat-v2/types";
import { logger } from "../logger";
import { ensurePiDirs, piCwdDir, piSessionDir } from "./config";

/** Marker appended to user-message text instead of inlining attachment bytes. */
export function attachmentMarker(ids: string[]): string {
	return `<solar-attachments ids="${ids.join(",")}"/>`;
}

const ATTACHMENT_MARKER_PATTERN = /<solar-attachments\s+ids="([^"]*)"\s*\/>/g;

/** A completed pi session exists for this conversation → route to pi engine. */
export function isPiSessionReady(conversationId: string): boolean {
	const dir = piSessionDir(conversationId);
	if (!existsSync(dir)) return false;
	try {
		return readdirSync(dir).some((name) => name.endsWith(".jsonl"));
	} catch {
		return false;
	}
}

/** The single session file of a migrated conversation (after import/spawn). */
export function piSessionFile(conversationId: string): string | null {
	const dir = piSessionDir(conversationId);
	if (!existsSync(dir)) return null;
	const file = readdirSync(dir).find((name) => name.endsWith(".jsonl"));
	return file ? join(dir, file) : null;
}

export interface ImportConversationResult {
	kind: "already" | "empty" | "imported";
	messagesImported: number;
	warnings: string[];
}

function messageText(message: Message): string {
	if (typeof message.content === "string") return message.content;
	return (message.content as Array<{ type: string; text?: string }>)
		.filter((part) => part.type === "text")
		.map((part) => part.text ?? "")
		.join("\n")
		.trim();
}

/**
 * Replacer for the persisted text shape: chat-v2 inlines attachments into
 * canonical payloads; pi sessions keep the compact reference marker instead,
 * expanded just-in-time by the bridge extension (plan: Tool injection &
 * attachment resolution).
 */
function toPiMessage(
	record: CanonicalMessageRecord,
	attachmentIds: string[],
): Message {
	const message = record.message;
	if (message.role === "user" && attachmentIds.length > 0) {
		const base = messageText(message);
		return {
			...message,
			content: base
				? `${base}\n${attachmentMarker(attachmentIds)}`
				: attachmentMarker(attachmentIds),
		};
	}
	return message;
}

export async function importConversation(
	userId: string,
	conversationId: string,
): Promise<ImportConversationResult> {
	if (isPiSessionReady(conversationId)) {
		return { kind: "already", messagesImported: 0, warnings: [] };
	}
	// Throws when the conversation doesn't exist / isn't owned.
	await chatV2Repository.getConversation(userId, conversationId);

	ensurePiDirs();
	mkdirSync(piCwdDir(conversationId), { recursive: true });

	const sessionDir = piSessionDir(conversationId);
	const tmpDir = `${sessionDir}.importing-${randomUUID()}`;
	rmSync(tmpDir, { recursive: true, force: true });
	mkdirSync(tmpDir, { recursive: true });

	const warnings: string[] = [];
	try {
		const manager = SessionManager.create(piCwdDir(conversationId), tmpDir, {
			id: conversationId,
		});

		const canonical = (
			await chatV2Repository.listCanonicalMessages(userId, conversationId)
		).filter(
			(record) => record.status !== "pending" && record.status !== "streaming",
		);
		const compactions = await chatV2Repository.listCompactions(
			userId,
			conversationId,
		);
		const bindings = await chatV2Repository.listMessageAttachments(
			userId,
			conversationId,
		);
		const attachmentIdsByMessageId = new Map<string, string[]>();
		for (const binding of bindings) {
			if (!binding.messageId) continue;
			attachmentIdsByMessageId.set(binding.messageId, [
				...(attachmentIdsByMessageId.get(binding.messageId) ?? []),
				binding.attachment.id,
			]);
		}

		const entryIdByMessageId = new Map<string, string>();
		for (const record of canonical) {
			const entryId = manager.appendMessage(
				toPiMessage(
					record,
					attachmentIdsByMessageId.get(record.id) ?? [],
				) as never,
			);
			entryIdByMessageId.set(record.id, entryId);
		}

		// For every chat-v2 compaction, append the corresponding pi compaction
		// entry. firstKeptEntryId is the FIRST message after the compaction's
		// range boundary (plan step 3); if the boundary is the tail, the
		// compaction summarizes everything and keeps nothing — pi's
		// buildContextEntries handles that by keeping only entries appended
		// after the compaction (none), so import still reproduces "summarised
		// everything" correctly.
		for (const compaction of compactions) {
			const boundaryIndex = canonical.findIndex(
				(record) => record.id === compaction.lastMessageId,
			);
			if (boundaryIndex < 0) {
				warnings.push(
					`compaction ${compaction.id} boundary not in canonical history; skipped`,
				);
				continue;
			}
			const firstKept = canonical
				.slice(boundaryIndex + 1)
				.map((record) => entryIdByMessageId.get(record.id))
				.find((id): id is string => Boolean(id));
			if (!firstKept) continue;
			const summary = compaction.replacementMessages
				.map(messageText)
				.filter(Boolean)
				.join("\n\n");
			manager.appendCompaction(
				summary,
				firstKept,
				compaction.tokensBefore ?? 0,
				{ solarCompactionId: compaction.id },
				false,
				compaction.tokensBefore && compaction.tokensAfter
					? {
							input: compaction.tokensBefore,
							output: compaction.tokensAfter,
							cacheRead: 0,
							cacheWrite: 0,
							totalTokens: compaction.tokensBefore + compaction.tokensAfter,
							cost: {
								input: 0,
								output: 0,
								cacheRead: 0,
								cacheWrite: 0,
								total: 0,
							},
						}
					: undefined,
			);
		}

		// Title: chat-v2 title is conversation-level metdata pi doesn't know
		// unless told. If the conversation was explicitly renamed (title !== the
		// default), preserve it as the session's display name.
		const conversation = await chatV2Repository.getConversation(
			userId,
			conversationId,
		);
		if (conversation.title && conversation.title !== "New conversation") {
			manager.appendSessionInfo(conversation.title);
		}

		// Verification pass (plan step 4): open the temp session FRESH (not the
		// writer instance) and confirm every canonical message's text survived,
		// and every referenced attachment ID still resolves. On failure we leave
		// the conversation unmigrated (chat-v2 keeps serving it).
		const sessionFilePath = manager.getSessionFile();
		if (!sessionFilePath) throw new Error("import produced no session file");
		const reopened = SessionManager.open(sessionFilePath, tmpDir).getEntries();
		const importedTexts = new Set(
			reopened
				.filter((entry) => entry.type === "message")
				.map((entry) =>
					stripMarkers(messageText((entry as { message: Message }).message)),
				),
		);
		for (const record of canonical) {
			const expected = messageText(record.message);
			if (!expected) continue;
			if (![...importedTexts].some((text) => text.includes(expected))) {
				throw new Error(
					`verification failed: canonical message ${record.id} did not round-trip`,
				);
			}
		}
		for (const ids of attachmentIdsByMessageId.values()) {
			for (const id of ids) {
				const exists = await chatV2Repository
					.getAttachment(userId, id)
					.catch(() => null);
				if (!exists)
					throw new Error(
						`verification failed: attachment ${id} no longer exists`,
					);
			}
		}

		mkdirSync(dirname(sessionDir), { recursive: true });
		renameSync(tmpDir, sessionDir);
		logger
			.withMetadata({ conversationId, userId, importCount: canonical.length })
			.info("chat-v2 conversation imported into pi session");
		return {
			kind: canonical.length === 0 ? "empty" : "imported",
			messagesImported: canonical.length,
			warnings,
		};
	} catch (error) {
		rmSync(tmpDir, { recursive: true, force: true });
		throw error;
	}
}

function stripMarkers(text: string): string {
	return text.replace(ATTACHMENT_MARKER_PATTERN, "").trim();
}
