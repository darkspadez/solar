import type { ChatV2Repository } from "../chat-v2/db/repository";
import type { AttachmentRecord } from "../chat-v2/types";
import {
	deleteAttachmentFilesByStorageKey,
	readAttachmentBytes,
	saveAttachmentFile,
} from "../chat/attachments";
import { AttachmentService } from "../chat-v2/attachments";
import { chatV2Repository } from "../chat/v2Live";

const MAX_INLINE_DATA_URL_LENGTH = 30 * 1024 * 1024;
const MAX_INLINE_ATTACHMENT_BYTES = 20 * 1024 * 1024;
const DATA_URL_PATTERN = /^data:([^;,]+)(;base64)?,([\s\S]*)$/i;
const FILE_ID_PATH_PATTERN = /\/api\/v1\/files\/([^/?#]+)(?:\/content)?\/?$/;

const MIME_BY_EXTENSION: Record<string, string> = {
	avif: "image/avif",
	bmp: "image/bmp",
	gif: "image/gif",
	jpeg: "image/jpeg",
	jpg: "image/jpeg",
	png: "image/png",
	svg: "image/svg+xml",
	webp: "image/webp",
	csv: "text/csv",
	log: "text/plain",
	markdown: "text/markdown",
	md: "text/markdown",
	sql: "application/sql",
	text: "text/plain",
	toml: "application/toml",
	tsv: "text/tab-separated-values",
	txt: "text/plain",
	xml: "application/xml",
	yaml: "application/yaml",
	yml: "application/yaml",
	json: "application/json",
	jsonld: "application/ld+json",
	doc: "application/msword",
	docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
	pdf: "application/pdf",
	xls: "application/vnd.ms-excel",
	xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
};

function unixSeconds(iso: string): number {
	const timestamp = Date.parse(iso);
	return Number.isFinite(timestamp) ? Math.floor(timestamp / 1000) : 0;
}

function extension(filename: string): string {
	const match = /\.([^.]+)$/.exec(filename.trim().toLowerCase());
	return match?.[1] ?? "";
}

export function inferMimeType(filename: string): string | null {
	return MIME_BY_EXTENSION[extension(filename)] ?? null;
}

export function normalizeUploadMimeType(
	filename: string,
	mimeType: string | undefined,
): string {
	const normalized = mimeType?.split(";", 1)[0]?.trim().toLowerCase() ?? "";
	if (
		normalized &&
		normalized !== "application/octet-stream" &&
		normalized !== "binary/octet-stream"
	) {
		return normalized;
	}
	return inferMimeType(filename) ?? (normalized || "application/octet-stream");
}

export function parseOpenWebUiMetadata(
	value: unknown,
): Record<string, unknown> {
	if (value === undefined || value === null || value === "") return {};
	if (typeof value === "string") {
		const parsed = JSON.parse(value) as unknown;
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
			throw new Error("metadata must be a JSON object");
		return parsed as Record<string, unknown>;
	}
	if (typeof value !== "object" || Array.isArray(value))
		throw new Error("metadata must be an object");
	return value as Record<string, unknown>;
}

export function openWebUiFileDescriptor(attachment: AttachmentRecord) {
	const isImage = attachment.kind === "image";
	return {
		id: attachment.id,
		type: isImage ? "image" : "file",
		url: attachment.id,
		name: attachment.filename,
		filename: attachment.filename,
		content_type: attachment.mimeType,
		size: attachment.byteSize,
		status: "uploaded",
	};
}

// History responses use the same descriptor shape as the upload response's
// file reference. Keep the longer name here because it describes the
// attachment-to-chat projection, while retaining openWebUiFileDescriptor for
// callers that are translating a file record directly.
export const openWebUiAttachmentDescriptor = openWebUiFileDescriptor;

export function openWebUiFileResponse(
	attachment: AttachmentRecord,
	metadata: Record<string, unknown> = {},
) {
	const createdAt = unixSeconds(attachment.createdAt);
	return {
		id: attachment.id,
		user_id: attachment.userId,
		hash: attachment.sha256,
		filename: attachment.filename,
		data: { status: "completed" },
		meta: {
			name: attachment.filename,
			content_type: attachment.mimeType,
			size: attachment.byteSize,
			file_hash: attachment.sha256,
			data: metadata,
		},
		// Keep the flat fields as well. Open Relay decodes the list endpoint
		// using this older shape, while Conduit prefers the nested `meta` form.
		content_type: attachment.mimeType,
		size: attachment.byteSize,
		created_at: createdAt,
		updated_at: createdAt,
		kind: attachment.kind,
		mimeType: attachment.mimeType,
		byteSize: attachment.byteSize,
	};
}

export async function saveOpenWebUiUpload(
	userId: string,
	file: File,
	metadata: Record<string, unknown> = {},
	repository: ChatV2Repository = chatV2Repository,
) {
	// Browsers normally send only the basename, but native clients can retain
	// a platform path in the multipart filename. Keep display metadata safe and
	// portable while leaving the attachment storage key server-controlled.
	const filename = file.name?.trim().replace(/^.*[\\/]/, "") || "attachment";
	const mimeType = normalizeUploadMimeType(filename, file.type);
	const bytes = new Uint8Array(await file.arrayBuffer());
	let attachment: Awaited<ReturnType<typeof saveAttachmentFile>> | null = null;
	try {
		attachment = await saveAttachmentFile({
			userId,
			filename,
			mimeType,
			bytes,
		});
		const persisted = await new AttachmentService(repository).create(
			userId,
			attachment,
		);
		return { attachment: persisted, metadata };
	} catch (error) {
		if (attachment) {
			await deleteAttachmentFilesByStorageKey([attachment.storageKey]);
		}
		throw error;
	}
}

export async function deleteOpenWebUiOrphan(
	userId: string,
	attachmentId: string,
	repository: ChatV2Repository = chatV2Repository,
): Promise<boolean> {
	// Distinguish a missing file from a file that is still referenced by chat
	// history. The route can then return a useful compatibility status while
	// preserving Solar's attachment ownership and history invariants.
	await repository.getAttachment(userId, attachmentId);
	const result = await repository.removeOrphanAttachment(userId, attachmentId);
	if (result.storageKey)
		await deleteAttachmentFilesByStorageKey([result.storageKey]);
	return result.removed;
}

export async function readOpenWebUiAttachment(
	userId: string,
	attachmentId: string,
	repository: ChatV2Repository = chatV2Repository,
) {
	const attachment = await repository.getAttachment(userId, attachmentId);
	const bytes = await readAttachmentBytes(attachment.storageKey);
	return { attachment, bytes };
}

function normalizeFileReference(value: string): string | null {
	const trimmed = value.trim();
	if (!trimmed || trimmed.startsWith("data:")) return trimmed || null;
	const pathMatch = FILE_ID_PATH_PATTERN.exec(trimmed);
	if (pathMatch?.[1]) return decodeURIComponent(pathMatch[1]);
	if (
		trimmed.startsWith("http://") ||
		trimmed.startsWith("https://") ||
		trimmed.startsWith("//") ||
		trimmed.startsWith("/")
	) {
		return null;
	}
	return trimmed;
}

function stringValue(value: unknown): string | null {
	return typeof value === "string" && value.trim() ? value.trim() : null;
}

function hasImageDescriptor(value: unknown): boolean {
	if (Array.isArray(value))
		return value.some((item) => hasImageDescriptor(item));
	if (!value || typeof value !== "object") return false;
	const record = value as Record<string, unknown>;
	const type = stringValue(record.type)?.toLowerCase();
	if (type === "image") return true;
	const contentType =
		stringValue(record.content_type) ??
		stringValue(record.mimeType) ??
		(record.meta && typeof record.meta === "object"
			? stringValue((record.meta as Record<string, unknown>).content_type)
			: null);
	if (contentType?.startsWith("image/")) return true;
	return hasImageDescriptor(record.file);
}

function descriptorReferences(value: unknown): Array<{
	value: string;
	filename?: string;
}> {
	if (typeof value === "string") return [{ value }];
	if (!value || typeof value !== "object" || Array.isArray(value)) return [];
	const record = value as Record<string, unknown>;
	const type = stringValue(record.type)?.toLowerCase();
	// Open Relay also places knowledge-base, note, and referenced-chat
	// descriptors in the top-level `files` array. Those IDs belong to other
	// Open WebUI resources, not Solar's v2_attachment table, and are already
	// represented by persisted Solar history (or are outside this facade's
	// scope). Only resolve actual uploaded file/image descriptors here.
	if (
		type &&
		["chat", "collection", "knowledge", "note", "web", "youtube"].includes(type)
	)
		return [];
	const filename =
		stringValue(record.name) ?? stringValue(record.filename) ?? undefined;
	const nested = descriptorReferences(record.file);
	const values = [
		record.id,
		record.file_id,
		record.fileId,
		record.url,
		record.attachment_id,
		record.attachmentId,
	].flatMap((candidate) => {
		const string = stringValue(candidate);
		return string ? [{ value: string, filename: filename ?? undefined }] : [];
	});
	return [
		...values,
		...nested.map((item) => ({
			...item,
			filename: item.filename ?? filename ?? undefined,
		})),
	];
}

function collectContentImageReferences(
	value: unknown,
	output: Array<{ value: string; filename?: string }>,
): void {
	if (Array.isArray(value)) {
		for (const item of value) collectContentImageReferences(item, output);
		return;
	}
	if (!value || typeof value !== "object") return;
	const record = value as Record<string, unknown>;
	const type = stringValue(record.type);
	if (type === "image_url") {
		const imageUrl = record.image_url;
		if (typeof imageUrl === "string") {
			output.push({ value: imageUrl });
		} else if (imageUrl && typeof imageUrl === "object") {
			const url = stringValue((imageUrl as Record<string, unknown>).url);
			if (url) output.push({ value: url });
		}
	}
	if (type === "image") {
		for (const key of ["image", "url", "data"]) {
			const candidate = stringValue(record[key]);
			if (candidate) output.push({ value: candidate });
		}
	}
}

function decodeDataUrl(value: string): { mimeType: string; bytes: Uint8Array } {
	if (value.length > MAX_INLINE_DATA_URL_LENGTH)
		throw new Error("Inline image exceeds the 20 MB limit");
	const match = DATA_URL_PATTERN.exec(value);
	if (!match) throw new Error("Invalid inline attachment data URL");
	const mimeType = normalizeUploadMimeType("attachment", match[1]);
	const payload = match[3]!;
	let bytes: Uint8Array;
	if (match[2]) {
		if (!/^[A-Za-z0-9+/]*={0,2}$/.test(payload) || payload.length % 4 === 1)
			throw new Error("Invalid base64 attachment data");
		const unpaddedLength = payload.replace(/=+$/, "").length;
		if (Math.ceil((unpaddedLength * 3) / 4) > MAX_INLINE_ATTACHMENT_BYTES)
			throw new Error("Inline image exceeds the 20 MB limit");
		try {
			bytes = new Uint8Array(Buffer.from(payload, "base64"));
		} catch {
			throw new Error("Invalid base64 attachment data");
		}
	} else {
		try {
			bytes = new TextEncoder().encode(decodeURIComponent(payload));
		} catch {
			throw new Error("Invalid attachment data URL encoding");
		}
	}
	return { mimeType, bytes };
}

function inlineFilename(mimeType: string, index: number): string {
	const mimeExtension = mimeType.split("/")[1]?.split("+")[0] || "bin";
	return `attachment-${index}.${mimeExtension}`;
}

function completionMessage(
	body: Record<string, unknown>,
): Record<string, unknown> {
	const userMessage =
		body.user_message && typeof body.user_message === "object"
			? (body.user_message as Record<string, unknown>)
			: null;
	if (userMessage) return userMessage;
	const parentMessage =
		body.parent_message && typeof body.parent_message === "object"
			? (body.parent_message as Record<string, unknown>)
			: null;
	if (parentMessage) return parentMessage;
	const messages = Array.isArray(body.messages) ? body.messages : [];
	const lastMessage = messages.at(-1);
	return lastMessage && typeof lastMessage === "object"
		? (lastMessage as Record<string, unknown>)
		: {};
}

/**
 * Resolves the attachment conventions emitted by both supported clients:
 * uploaded file descriptors/IDs, legacy attachment_ids, and inline
 * image_url data URLs. Inline data is persisted into the same Chat V2
 * attachment tables so it gets ownership checks, history, and provider
 * expansion for free.
 */
export async function resolveCompletionAttachmentIds(
	userId: string,
	body: Record<string, unknown>,
	repository: ChatV2Repository = chatV2Repository,
): Promise<{ attachmentIds: string[]; createdInlineIds: string[] }> {
	const currentMessage = completionMessage(body);
	const candidates: Array<{ value: string; filename?: string }> = [];
	const currentMessageCandidates = [
		currentMessage.files,
		currentMessage.attachment_ids,
		currentMessage.attachmentIds,
	];
	for (const value of [
		body.attachment_ids,
		body.attachmentIds,
		...currentMessageCandidates,
	]) {
		if (Array.isArray(value)) {
			for (const item of value) candidates.push(...descriptorReferences(item));
		} else {
			candidates.push(...descriptorReferences(value));
		}
	}
	// Both clients normally upload images first and then include the image
	// again as an OpenAI `image_url` data URL in the completion messages. The
	// durable file descriptor is authoritative in that case; retaining both
	// would display and send the same image twice. Inline images remain
	// supported when no uploaded image descriptor is present.
	if (!hasImageDescriptor(currentMessage.files))
		collectContentImageReferences(currentMessage.content, candidates);
	// Open Relay's top-level `files` includes files from prior user turns for
	// RAG. Bind only the current user-message refs above, unless a client sent
	// no current-message attachment shape at all and top-level files is the
	// only representation available (as some older Open WebUI clients do).
	const hasCompletionMessageEnvelope =
		(body.user_message && typeof body.user_message === "object") ||
		(body.parent_message && typeof body.parent_message === "object") ||
		(Array.isArray(body.messages) && body.messages.length > 0);
	const hasCurrentMessageAttachmentShape =
		currentMessageCandidates.some(
			(value) => Array.isArray(value) && value.length > 0,
		) || candidates.some((candidate) => candidate.value.startsWith("data:"));
	if (!hasCurrentMessageAttachmentShape && !hasCompletionMessageEnvelope) {
		const topLevelFiles = body.files;
		if (Array.isArray(topLevelFiles)) {
			for (const item of topLevelFiles)
				candidates.push(...descriptorReferences(item));
		} else {
			candidates.push(...descriptorReferences(topLevelFiles));
		}
	}

	const attachmentIds: string[] = [];
	const createdInlineIds: string[] = [];
	const seenReferences = new Set<string>();
	let inlineIndex = 0;
	try {
		for (const candidate of candidates) {
			const reference = normalizeFileReference(candidate.value);
			if (!reference || seenReferences.has(reference)) continue;
			seenReferences.add(reference);

			if (reference.startsWith("data:")) {
				const decoded = decodeDataUrl(reference);
				const attachment = await saveAttachmentFile({
					userId,
					filename:
						candidate.filename ??
						inlineFilename(decoded.mimeType, ++inlineIndex),
					mimeType: decoded.mimeType,
					bytes: decoded.bytes,
				});
				try {
					await new AttachmentService(repository).create(userId, attachment);
				} catch (error) {
					await deleteAttachmentFilesByStorageKey([attachment.storageKey]);
					throw error;
				}
				attachmentIds.push(attachment.id);
				createdInlineIds.push(attachment.id);
				continue;
			}

			await repository.getAttachment(userId, reference);
			attachmentIds.push(reference);
		}
	} catch (error) {
		for (const attachmentId of createdInlineIds)
			await deleteOpenWebUiOrphan(userId, attachmentId, repository).catch(
				() => false,
			);
		throw error;
	}
	return { attachmentIds, createdInlineIds };
}

export function processStatusSse(): Response {
	return new Response(`data: ${JSON.stringify({ status: "completed" })}\n\n`, {
		headers: {
			"cache-control": "no-cache",
			connection: "keep-alive",
			"content-type": "text/event-stream",
		},
	});
}
