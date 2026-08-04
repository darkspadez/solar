import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import { createV2TestDatabase } from "../chat-v2/db/fixtures";
import { ChatV2Repository } from "../chat-v2/db/repository";
import type { AttachmentRecord } from "../chat-v2/types";

const OWNER_ID = "openwebui-files-owner";
const OTHER_USER_ID = "openwebui-files-other";
const OWNER_TOKEN = "sk_solar_files_owner";
const OTHER_TOKEN = "sk_solar_files_other";

const database = await createV2TestDatabase();
const repository = new ChatV2Repository(database.db);
const storedFiles = new Map<string, Uint8Array>();
const completionCalls: Array<Record<string, unknown>> = [];

process.env.SOLAR_ATTACHMENTS_DIR = "/test/openwebui-files";

mock.module("../db", () => ({ db: database.db, sqlite: database.sqlite }));
mock.module("../auth", () => ({
	getSolarSession: async () => null,
	auth: {
		api: {
			verifyApiKey: async ({ body }: { body: { key: string } }) => ({
				valid: true,
				key: {
					referenceId: body.key === OTHER_TOKEN ? OTHER_USER_ID : OWNER_ID,
				},
			}),
			signInEmail: async () => ({ user: { id: OWNER_ID } }),
		},
	},
	createSolarApiKey: async () => ({ id: "key", key: OWNER_TOKEN }),
}));
mock.module("../chat/catalog", () => ({
	listAvailableModels: async () => [
		{
			provider: "mock",
			endpointId: "mock",
			modelId: "mock-model",
			api: "mock",
			name: "Mock Model",
			reasoning: false,
			vision: true,
			documents: true,
		},
	],
	resolveSelection: async () => ({
		provider: "mock",
		endpointId: "mock",
		modelId: "mock-model",
		api: "mock",
	}),
}));
mock.module("../chat/v2Live", () => ({
	chatV2Repository: repository,
	loadMessages: async () => [],
	sendMessage: async (input: Record<string, unknown>) => {
		completionCalls.push(input);
		return "assistant-message";
	},
	stopGeneration: async () => true,
}));
mock.module("@struktoai/mirage-node", () => {
	type PathLike = { toString(): string };

	class TestDiskResource {
		async open(): Promise<void> {}

		async mkdir(_path: PathLike, _options?: unknown): Promise<void> {}

		async writeFile(path: PathLike, bytes: Uint8Array): Promise<void> {
			storedFiles.set(path.toString(), new Uint8Array(bytes));
		}

		async readFile(path: PathLike): Promise<Uint8Array> {
			const bytes = storedFiles.get(path.toString());
			if (!bytes) throw new Error(`missing test attachment ${path.toString()}`);
			return new Uint8Array(bytes);
		}

		async unlink(path: PathLike): Promise<void> {
			storedFiles.delete(path.toString());
		}
	}

	return {
		DiskResource: TestDiskResource,
		PathSpec: {
			fromStrPath(path: string): PathLike {
				return { toString: () => path };
			},
		},
	};
});

const {
	openWebUiAttachmentDescriptor,
	openWebUiFileDescriptor,
	openWebUiFileResponse,
	parseOpenWebUiMetadata,
	readOpenWebUiAttachment,
	resolveCompletionAttachmentIds,
	saveOpenWebUiUpload,
} = await import("./files");
const { createOpenWebUiRoutes } = await import("./routes");

const gateway = {
	attachTask: () => {},
	taskIds: () => [],
	stopTasks: async () => false,
	stopTask: async () => false,
	close: () => {},
};
const routes = createOpenWebUiRoutes(gateway as never);

function request(
	path: string,
	init: RequestInit = {},
	token = OWNER_TOKEN,
): Promise<Response> {
	return Promise.resolve(
		routes.request(`http://solar.local${path}`, {
			...init,
			headers: {
				authorization: `Bearer ${token}`,
				...init.headers,
			},
		}),
	);
}

function attachmentRecord(
	overrides: Partial<AttachmentRecord> = {},
): AttachmentRecord {
	return {
		id: "attachment-record",
		userId: OWNER_ID,
		storageKey: `${OWNER_ID}/attachment-record`,
		filename: "record.txt",
		mimeType: "text/plain",
		kind: "text",
		byteSize: 12,
		sha256: "record-sha256",
		width: null,
		height: null,
		pageCount: null,
		createdAt: "2026-08-04T12:34:56.000Z",
		...overrides,
	};
}

async function uploadForTest(
	userId = OWNER_ID,
	file = new File(["owner content"], "notes.txt", {
		type: "application/octet-stream",
	}),
	metadata: Record<string, unknown> = {},
) {
	const result = await saveOpenWebUiUpload(userId, file, metadata, repository);
	if (!result.attachment)
		throw new Error("test upload did not create an attachment");
	return result.attachment;
}

beforeAll(() => {
	database.sqlite.exec(
		"alter table user add column name text; alter table user add column email text; alter table user add column role text; alter table user add column isDisabled integer;",
	);
	database.seedUser(OWNER_ID);
	database.seedUser(OTHER_USER_ID);
	database.sqlite
		.query(
			"update user set name = ?, email = ?, role = ?, isDisabled = 0 where id = ?",
		)
		.run(
			"Open WebUI Files Owner",
			"files-owner@example.test",
			"user",
			OWNER_ID,
		);
	database.sqlite
		.query(
			"update user set name = ?, email = ?, role = ?, isDisabled = 0 where id = ?",
		)
		.run(
			"Open WebUI Files Other",
			"files-other@example.test",
			"user",
			OTHER_USER_ID,
		);
});

afterAll(async () => database.destroy());

describe("Open WebUI file and image helpers", () => {
	test("parses multipart metadata as an object", () => {
		expect(parseOpenWebUiMetadata(undefined)).toEqual({});
		expect(parseOpenWebUiMetadata("")).toEqual({});
		expect(
			parseOpenWebUiMetadata(
				JSON.stringify({
					knowledge_id: "knowledge-1",
					file_hash: "provided-hash",
				}),
			),
		).toEqual({
			knowledge_id: "knowledge-1",
			file_hash: "provided-hash",
		});
		expect(parseOpenWebUiMetadata({ channel_id: "channel-1" })).toEqual({
			channel_id: "channel-1",
		});
		expect(() => parseOpenWebUiMetadata("[]")).toThrow(
			"metadata must be a JSON object",
		);
		expect(() => parseOpenWebUiMetadata(42)).toThrow(
			"metadata must be an object",
		);
	});

	test("emits descriptors and response metadata understood by both clients", () => {
		const image = attachmentRecord({
			id: "image-attachment",
			filename: "photo.png",
			mimeType: "image/png",
			kind: "image",
			byteSize: 4,
		});
		const file = attachmentRecord({
			id: "file-attachment",
			filename: "report.pdf",
			mimeType: "application/pdf",
			kind: "document",
			byteSize: 2048,
		});

		expect(openWebUiFileDescriptor(image)).toEqual({
			id: "image-attachment",
			type: "image",
			url: "image-attachment",
			name: "photo.png",
			filename: "photo.png",
			content_type: "image/png",
			size: 4,
			status: "uploaded",
		});
		expect(openWebUiAttachmentDescriptor(file)).toMatchObject({
			id: "file-attachment",
			type: "file",
			url: "file-attachment",
			name: "report.pdf",
			filename: "report.pdf",
			content_type: "application/pdf",
			size: 2048,
			status: "uploaded",
		});

		expect(
			openWebUiFileResponse(file, { knowledge_id: "knowledge-1" }),
		).toMatchObject({
			id: "file-attachment",
			user_id: OWNER_ID,
			hash: "record-sha256",
			filename: "report.pdf",
			data: { status: "completed" },
			meta: {
				name: "report.pdf",
				content_type: "application/pdf",
				size: 2048,
				file_hash: "record-sha256",
				data: { knowledge_id: "knowledge-1" },
			},
			content_type: "application/pdf",
			size: 2048,
			kind: "document",
			mimeType: "application/pdf",
			byteSize: 2048,
		});
	});

	test("stores a multipart upload and serves its bytes only to its owner", async () => {
		const attachment = await uploadForTest(
			OWNER_ID,
			new File(["multipart bytes"], "notes.txt", {
				type: "application/octet-stream",
			}),
			{ source: "open-relay" },
		);

		expect(attachment).toMatchObject({
			userId: OWNER_ID,
			filename: "notes.txt",
			mimeType: "text/plain",
			kind: "text",
			byteSize: 15,
		});
		expect(await repository.getAttachment(OWNER_ID, attachment.id)).toEqual(
			attachment,
		);

		const served = await readOpenWebUiAttachment(
			OWNER_ID,
			attachment.id,
			repository,
		);
		expect(served.attachment).toEqual(attachment);
		expect(Array.from(served.bytes)).toEqual(
			Array.from(new TextEncoder().encode("multipart bytes")),
		);
		await expect(
			readOpenWebUiAttachment(OTHER_USER_ID, attachment.id, repository),
		).rejects.toThrow();
	});

	test("resolves uploaded IDs, content URLs, and inline image data once", async () => {
		const uploaded = await uploadForTest(
			OWNER_ID,
			new File(["uploaded image"], "uploaded.png", { type: "image/png" }),
		);
		const historical = await uploadForTest(
			OWNER_ID,
			new File(["historical document"], "historical.txt", {
				type: "text/plain",
			}),
		);
		const inlineBytes = new TextEncoder().encode("inline image");
		const inlineDataUrl = `data:image/png;base64,${Buffer.from(
			inlineBytes,
		).toString("base64")}`;

		const resolved = await resolveCompletionAttachmentIds(
			OWNER_ID,
			{
				files: [
					{ id: historical.id, name: "historical.txt" },
					{ id: uploaded.id, name: "uploaded.png" },
					{ url: "https://remote.example/image.png" },
				],
				attachment_ids: [uploaded.id],
				user_message: {
					files: [
						{
							content_type: "image/png",
							url: `/api/v1/files/${encodeURIComponent(uploaded.id)}/content`,
						},
					],
					content: [
						{ type: "text", text: "Describe this" },
						{ type: "image_url", image_url: { url: inlineDataUrl } },
						{ type: "image_url", image_url: { url: inlineDataUrl } },
					],
				},
			},
			repository,
		);

		expect(resolved.attachmentIds[0]).toBe(uploaded.id);
		expect(resolved.attachmentIds).toHaveLength(1);
		expect(resolved.attachmentIds).not.toContain(historical.id);
		expect(resolved.createdInlineIds).toHaveLength(0);

		const inlineOnly = await resolveCompletionAttachmentIds(
			OWNER_ID,
			{
				user_message: {
					content: [
						{ type: "text", text: "Describe this" },
						{ type: "image_url", image_url: { url: inlineDataUrl } },
						{ type: "image_url", image_url: { url: inlineDataUrl } },
					],
				},
			},
			repository,
		);
		expect(inlineOnly.createdInlineIds).toHaveLength(1);
		const inlineId = inlineOnly.createdInlineIds[0]!;
		const inline = await repository.getAttachment(OWNER_ID, inlineId);
		expect(inline).toMatchObject({
			userId: OWNER_ID,
			filename: "attachment-1.png",
			mimeType: "image/png",
			kind: "image",
			byteSize: inlineBytes.byteLength,
		});
		const inlineContent = await readOpenWebUiAttachment(
			OWNER_ID,
			inlineId,
			repository,
		);
		expect(Array.from(inlineContent.bytes)).toEqual(Array.from(inlineBytes));

		await expect(
			resolveCompletionAttachmentIds(
				OTHER_USER_ID,
				{ attachment_ids: [uploaded.id] },
				repository,
			),
		).rejects.toThrow();

		const followUp = await resolveCompletionAttachmentIds(
			OWNER_ID,
			{
				files: [{ id: historical.id, name: "historical.txt" }],
				user_message: { role: "user", content: "Continue" },
			},
			repository,
		);
		expect(followUp.attachmentIds).toEqual([]);
	});
});

describe("Open WebUI file and completion routes", () => {
	test("accepts multipart uploads and returns the Open WebUI file response", async () => {
		const form = new FormData();
		form.set(
			"file",
			new File(["route upload"], "route.txt", { type: "text/plain" }),
		);
		form.set(
			"metadata",
			JSON.stringify({ source: "conduit", file_hash: "route-hash" }),
		);

		const response = await request("/api/v1/files/?process=false", {
			method: "POST",
			body: form,
		});
		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({
			status: true,
			id: expect.any(String),
			user_id: OWNER_ID,
			filename: "route.txt",
			meta: {
				name: "route.txt",
				content_type: expect.stringMatching(/^text\/plain(?:;|$)/),
				size: 12,
				data: { source: "conduit", file_hash: "route-hash" },
			},
		});
	});

	test("serves file content with its MIME type and enforces route ownership", async () => {
		const attachment = await uploadForTest(
			OWNER_ID,
			new File(["route content"], "route.txt", { type: "text/plain" }),
		);

		const ownerResponse = await request(
			`/api/v1/files/${encodeURIComponent(attachment.id)}/content`,
		);
		expect(ownerResponse.status).toBe(200);
		expect(ownerResponse.headers.get("content-type")).toContain("text/plain");
		expect(
			Array.from(new Uint8Array(await ownerResponse.arrayBuffer())),
		).toEqual(Array.from(new TextEncoder().encode("route content")));

		const otherResponse = await request(
			`/api/v1/files/${encodeURIComponent(attachment.id)}/content`,
			{},
			OTHER_TOKEN,
		);
		expect(otherResponse.status).toBe(404);
	});

	test("lists files and acknowledges processing and batch retrieval routes", async () => {
		const attachment = await uploadForTest(
			OWNER_ID,
			new File(["batch content"], "batch.txt", { type: "text/plain" }),
		);

		const listed = await request("/api/v1/files/?page=1&content=false");
		expect(listed.status).toBe(200);
		expect(await listed.json()).toEqual(
			expect.objectContaining({
				total: expect.any(Number),
				items: expect.arrayContaining([
					expect.objectContaining({ id: attachment.id, filename: "batch.txt" }),
				]),
			}),
		);

		const processStatus = await request(
			`/api/v1/files/${attachment.id}/process/status`,
		);
		expect(processStatus.status).toBe(200);
		expect(await processStatus.json()).toEqual({ status: "completed" });

		const processStream = await request(
			`/api/v1/files/${attachment.id}/process/status?stream=true`,
		);
		expect(processStream.status).toBe(200);
		expect(processStream.headers.get("content-type")).toContain(
			"text/event-stream",
		);
		expect(await processStream.text()).toContain('"status":"completed"');

		const batch = await request("/api/v1/retrieval/process/files/batch", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				files: [openWebUiFileResponse(attachment)],
				collection_name: "batch-test",
			}),
		});
		expect(batch.status).toBe(200);
		expect(await batch.json()).toEqual({
			results: [{ file_id: attachment.id, status: "completed" }],
			errors: [],
		});

		const compactBatch = await request(
			"/api/v1/retrieval/process/files/batch",
			{
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ file_ids: [attachment.id] }),
			},
		);
		expect(compactBatch.status).toBe(200);
		expect(await compactBatch.json()).toEqual({
			results: [{ file_id: attachment.id, status: "completed" }],
			errors: [],
		});

		const crossUserBatch = await request(
			"/api/v1/retrieval/process/files/batch",
			{
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ file_ids: [attachment.id] }),
			},
			OTHER_TOKEN,
		);
		expect(crossUserBatch.status).toBe(200);
		expect(await crossUserBatch.json()).toEqual({
			results: [],
			errors: [
				{
					file_id: attachment.id,
					status: "failed",
					error: "File not found",
				},
			],
		});
	});

	test("passes completion attachment IDs to Solar message generation", async () => {
		const attachment = await uploadForTest(
			OWNER_ID,
			new File(["completion attachment"], "completion.txt", {
				type: "text/plain",
			}),
		);
		const conversation = await repository.createConversation(OWNER_ID, {
			id: "openwebui-files-completion",
			title: "Files completion",
		});
		completionCalls.splice(0);

		const response = await request("/api/chat/completions", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				stream: true,
				model: "mock-model",
				tool_servers: [],
				chat_id: conversation.id,
				user_message: {
					role: "user",
					content: "Read this file",
					files: [{ id: attachment.id, type: "file", name: "completion.txt" }],
				},
				attachment_ids: [attachment.id],
			}),
		});

		expect(response.status).toBe(200);
		expect(completionCalls[0]).toMatchObject({
			userId: OWNER_ID,
			conversationId: conversation.id,
			text: "Read this file",
			attachmentIds: [attachment.id],
		});
	});
});
