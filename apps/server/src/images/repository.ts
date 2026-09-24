import type { Kysely, Selectable, Transaction } from "kysely";
import { db } from "../db";
import type {
	Database,
	ImageAssetKind,
	ImageAssetTable,
	ImageAttemptStatus,
	ImageAttemptTable,
	ImageWorkspaceTable,
} from "../db/schema";
import { ImageStorage, imageStorage } from "./storage";

type Executor = Kysely<Database> | Transaction<Database>;

export type ImageWorkspaceRecord = Selectable<ImageWorkspaceTable>;
export type ImageAssetRecord = Selectable<ImageAssetTable>;
export type ImageAttemptRecord = Selectable<ImageAttemptTable>;

const ACTIVE_STATUSES: ImageAttemptStatus[] = ["queued", "running"];
const INTERRUPTED_MESSAGE = "Image generation was interrupted.";

export interface CreateWorkspaceInput {
	id?: string;
	title?: string;
	modelId?: string | null;
	aspectRatio?: string | null;
	resolution?: string | null;
}

export interface UploadInitialImageInput {
	id?: string;
	filename: string;
	mimeType: string;
	bytes: Uint8Array;
}

export interface CreateAttemptInput {
	id?: string;
	requestKey?: string;
	sourceAssetId?: string | null;
	retryOfAttemptId?: string | null;
	prompt: string;
	provider?: string;
	endpointId?: string;
	api?: string;
	modelId: string;
	aspectRatio?: string | null;
	resolution?: string | null;
}

export interface GeneratedImageInput {
	filename: string;
	mimeType: string;
	bytes: Uint8Array;
	usageJson?: string | null;
	costMicros?: number | null;
}

export interface ImageWorkspaceDetails extends ImageWorkspaceRecord {
	assets: ImageAssetRecord[];
	attempts: ImageAttemptRecord[];
	activeAttempt: ImageAttemptRecord | null;
	currentAssetId: string | null;
}

export interface ReadImageAsset {
	asset: ImageAssetRecord;
	bytes: Uint8Array;
}

export class ImageNotFoundError extends Error {
	constructor(resource: string, id: string | undefined) {
		super(`${resource} ${id} was not found for this user`);
		this.name = "ImageNotFoundError";
	}
}

export class ImageWorkspaceBusyError extends Error {
	constructor(message = "Image workspace already has an active generation") {
		super(message);
		this.name = "ImageWorkspaceBusyError";
	}
}

export class ImageConflictError extends ImageWorkspaceBusyError {
	constructor(message = "Image workspace already has an active generation") {
		super(message);
		this.name = "ImageConflictError";
	}
}

export class ImageWorkspaceStartedError extends Error {
	constructor(
		message = "This workspace already has an image; create a new workspace for another upload",
	) {
		super(message);
		this.name = "ImageWorkspaceStartedError";
	}
}

function now(): string {
	return new Date().toISOString();
}

function newId(): string {
	return crypto.randomUUID();
}

function changed(result: { numUpdatedRows?: bigint | number }): boolean {
	return Number(result.numUpdatedRows ?? 0) > 0;
}

function isActiveStatus(status: string): status is ImageAttemptStatus {
	return ACTIVE_STATUSES.includes(status as ImageAttemptStatus);
}

function isActiveAttemptUniqueError(error: unknown): boolean {
	if (!(error instanceof Error)) return false;
	return (
		error.message.includes("image_attempt_one_active_workspace_idx") ||
		(error.message.includes("image_attempt.workspaceId") &&
			!error.message.includes("requestKey"))
	);
}

export class ImageRepository {
	constructor(
		private readonly database: Kysely<Database>,
		private readonly storage: ImageStorage = imageStorage,
	) {}

	async list(userId: string): Promise<ImageWorkspaceRecord[]> {
		return this.database
			.selectFrom("image_workspace")
			.selectAll()
			.where("userId", "=", userId)
			.orderBy("updatedAt", "desc")
			.orderBy("createdAt", "desc")
			.execute();
	}

	async get(
		userId: string,
		workspaceId: string,
	): Promise<ImageWorkspaceDetails> {
		const workspace = await this.requireWorkspace(
			this.database,
			userId,
			workspaceId,
		);
		const [assets, attempts] = await Promise.all([
			this.database
				.selectFrom("image_asset")
				.selectAll()
				.where("workspaceId", "=", workspaceId)
				.where("userId", "=", userId)
				.orderBy("createdAt", "asc")
				.execute(),
			this.database
				.selectFrom("image_attempt")
				.selectAll()
				.where("workspaceId", "=", workspaceId)
				.where("userId", "=", userId)
				.orderBy("createdAt", "asc")
				.execute(),
		]);
		const activeAttempt =
			attempts.find((attempt) => isActiveStatus(attempt.status)) ?? null;
		const latestResult = [...attempts]
			.reverse()
			.find((attempt) => attempt.resultAssetId !== null)?.resultAssetId;
		return {
			...workspace,
			assets,
			attempts,
			activeAttempt,
			currentAssetId: latestResult ?? assets.at(-1)?.id ?? null,
		};
	}

	async createWorkspace(
		userId: string,
		input: CreateWorkspaceInput = {},
	): Promise<ImageWorkspaceRecord> {
		const title = input.title?.trim() || "Untitled image";
		if (title.length > 200)
			throw new Error("Image workspace title is too long");
		const createdAt = now();
		const record: ImageWorkspaceRecord = {
			id: input.id ?? newId(),
			userId,
			title,
			modelId: input.modelId ?? null,
			aspectRatio: input.aspectRatio ?? null,
			resolution: input.resolution ?? null,
			createdAt,
			updatedAt: createdAt,
		};
		await this.database.insertInto("image_workspace").values(record).execute();
		return record;
	}

	async uploadInitialImage(
		userId: string,
		workspaceId: string,
		input: UploadInitialImageInput,
	): Promise<ImageAssetRecord> {
		await this.requireWorkspace(this.database, userId, workspaceId);
		const assetId = input.id ?? newId();
		const stored = await this.storage.save(
			workspaceId,
			assetId,
			input.bytes,
			input.mimeType,
		);
		const record: ImageAssetRecord = {
			id: assetId,
			userId,
			workspaceId,
			sourceAssetId: null,
			kind: "upload",
			filename: input.filename.trim() || `upload-${assetId}`,
			mimeType: stored.mimeType,
			byteSize: stored.byteSize,
			sha256: stored.sha256,
			width: stored.width,
			height: stored.height,
			storageKey: stored.storageKey,
			createdAt: now(),
		};
		try {
			await this.database.transaction().execute(async (trx) => {
				await this.requireWorkspace(trx, userId, workspaceId);
				const existingAsset = await trx
					.selectFrom("image_asset")
					.select("id")
					.where("workspaceId", "=", workspaceId)
					.executeTakeFirst();
				const existingAttempt = await trx
					.selectFrom("image_attempt")
					.select("id")
					.where("workspaceId", "=", workspaceId)
					.executeTakeFirst();
				if (existingAsset || existingAttempt)
					throw new ImageWorkspaceStartedError();
				await trx.insertInto("image_asset").values(record).execute();
				await trx
					.updateTable("image_workspace")
					.set({ updatedAt: record.createdAt })
					.where("id", "=", workspaceId)
					.where("userId", "=", userId)
					.execute();
			});
		} catch (error) {
			await this.storage.remove([stored.storageKey]).catch(() => {});
			throw error;
		}
		return record;
	}

	/** Inserts a queued attempt. The partial unique index is the atomic claim. */
	async createAttempt(
		userId: string,
		workspaceId: string,
		input: CreateAttemptInput,
	): Promise<ImageAttemptRecord> {
		const createdAt = now();
		const record: ImageAttemptRecord = {
			id: input.id ?? newId(),
			userId,
			workspaceId,
			sourceAssetId: input.sourceAssetId ?? null,
			retryOfAttemptId: input.retryOfAttemptId ?? null,
			requestKey: input.requestKey ?? input.id ?? newId(),
			prompt: input.prompt,
			provider: input.provider ?? "openrouter",
			endpointId: input.endpointId ?? "openrouter-images",
			api: input.api ?? "openrouter-images",
			modelId: input.modelId,
			aspectRatio: input.aspectRatio ?? null,
			resolution: input.resolution ?? null,
			status: "queued",
			errorMessage: null,
			usageJson: null,
			costMicros: null,
			resultAssetId: null,
			createdAt,
			startedAt: null,
			finishedAt: null,
		};
		try {
			await this.database.transaction().execute(async (trx) => {
				await this.requireWorkspace(trx, userId, workspaceId);
				const existingAsset = await trx
					.selectFrom("image_asset")
					.select("id")
					.where("workspaceId", "=", workspaceId)
					.executeTakeFirst();
				if (record.sourceAssetId)
					await this.requireAssetInWorkspace(
						trx,
						userId,
						workspaceId,
						record.sourceAssetId,
					);
				else if (existingAsset) throw new ImageWorkspaceStartedError();
				if (record.retryOfAttemptId) {
					const retryOf = await this.requireAttempt(
						trx,
						userId,
						record.retryOfAttemptId,
					);
					if (retryOf.workspaceId !== workspaceId)
						throw new ImageNotFoundError(
							"image attempt",
							record.retryOfAttemptId,
						);
				}
				await trx.insertInto("image_attempt").values(record).execute();
				await trx
					.updateTable("image_workspace")
					.set({
						modelId: record.modelId,
						aspectRatio: record.aspectRatio,
						resolution: record.resolution,
						updatedAt: createdAt,
					})
					.where("id", "=", workspaceId)
					.where("userId", "=", userId)
					.execute();
			});
		} catch (error) {
			const existing = await this.database
				.selectFrom("image_attempt")
				.selectAll()
				.where("workspaceId", "=", workspaceId)
				.where("userId", "=", userId)
				.where("requestKey", "=", record.requestKey)
				.executeTakeFirst();
			if (existing) return existing;
			if (isActiveAttemptUniqueError(error)) throw new ImageConflictError();
			throw error;
		}
		return record;
	}

	async createRetryAttempt(
		userId: string,
		attemptId: string,
	): Promise<ImageAttemptRecord> {
		const previous = await this.requireAttempt(
			this.database,
			userId,
			attemptId,
		);
		if (previous.status !== "failed" && previous.status !== "interrupted") {
			throw new Error(
				"Only failed or interrupted image attempts can be retried",
			);
		}
		return this.createAttempt(userId, previous.workspaceId, {
			sourceAssetId: previous.sourceAssetId,
			retryOfAttemptId: previous.id,
			prompt: previous.prompt,
			provider: previous.provider,
			endpointId: previous.endpointId,
			api: previous.api,
			modelId: previous.modelId,
			aspectRatio: previous.aspectRatio,
			resolution: previous.resolution,
		});
	}

	async claimAttempt(
		userId: string,
		attemptId: string,
	): Promise<ImageAttemptRecord | null> {
		const startedAt = now();
		const result = await this.database
			.updateTable("image_attempt")
			.set({ status: "running", startedAt })
			.where("id", "=", attemptId)
			.where("userId", "=", userId)
			.where("status", "=", "queued")
			.executeTakeFirst();
		if (!changed(result)) return null;
		return this.requireAttempt(this.database, userId, attemptId);
	}

	async completeAttemptWithImage(
		userId: string,
		attemptId: string,
		input: GeneratedImageInput,
	): Promise<ImageAssetRecord | null> {
		const attempt = await this.requireAttempt(this.database, userId, attemptId);
		const assetId = newId();
		const stored = await this.storage.save(
			attempt.workspaceId,
			assetId,
			input.bytes,
			input.mimeType,
		);
		const asset: ImageAssetRecord = {
			id: assetId,
			userId,
			workspaceId: attempt.workspaceId,
			sourceAssetId: attempt.sourceAssetId,
			kind: "generated",
			filename: input.filename,
			mimeType: stored.mimeType,
			byteSize: stored.byteSize,
			sha256: stored.sha256,
			width: stored.width,
			height: stored.height,
			storageKey: stored.storageKey,
			createdAt: now(),
		};
		try {
			const completed = await this.database
				.transaction()
				.execute(async (trx) => {
					const current = await this.requireAttempt(trx, userId, attemptId);
					if (!isActiveStatus(current.status)) return false;
					await this.requireWorkspace(trx, userId, current.workspaceId);
					await trx.insertInto("image_asset").values(asset).execute();
					const result = await trx
						.updateTable("image_attempt")
						.set({
							status: "complete",
							resultAssetId: asset.id,
							usageJson: input.usageJson ?? null,
							costMicros: input.costMicros ?? null,
							errorMessage: null,
							finishedAt: asset.createdAt,
						})
						.where("id", "=", attemptId)
						.where("userId", "=", userId)
						.where("status", "in", ACTIVE_STATUSES)
						.executeTakeFirst();
					if (!changed(result)) {
						await trx
							.deleteFrom("image_asset")
							.where("id", "=", asset.id)
							.execute();
						return false;
					}
					await trx
						.updateTable("image_workspace")
						.set({ updatedAt: asset.createdAt })
						.where("id", "=", current.workspaceId)
						.where("userId", "=", userId)
						.execute();
					return true;
				});
			if (!completed) {
				await this.storage.remove([stored.storageKey]);
				return null;
			}
			return asset;
		} catch (error) {
			await this.storage.remove([stored.storageKey]).catch(() => {});
			throw error;
		}
	}

	async failAttempt(
		userId: string,
		attemptId: string,
		errorMessage: string,
	): Promise<boolean> {
		const result = await this.database
			.updateTable("image_attempt")
			.set({
				status: "failed",
				errorMessage: errorMessage.slice(0, 2_000),
				finishedAt: now(),
			})
			.where("id", "=", attemptId)
			.where("userId", "=", userId)
			.where("status", "in", ACTIVE_STATUSES)
			.executeTakeFirst();
		return changed(result);
	}

	async deleteWorkspace(userId: string, workspaceId: string): Promise<void> {
		await this.database.transaction().execute(async (trx) => {
			await this.requireWorkspace(trx, userId, workspaceId);
			await trx
				.deleteFrom("image_workspace")
				.where("id", "=", workspaceId)
				.where("userId", "=", userId)
				.execute();
		});
		await this.storage.removeWorkspace(workspaceId);
	}

	async deleteUserWorkspaces(userId: string): Promise<void> {
		const workspaces = await this.list(userId);
		for (const workspace of workspaces) {
			await this.deleteWorkspace(userId, workspace.id);
		}
	}

	async recoverActiveAttempts(userId?: string): Promise<number> {
		let query = this.database
			.updateTable("image_attempt")
			.set({
				status: "interrupted",
				errorMessage: INTERRUPTED_MESSAGE,
				finishedAt: now(),
			})
			.where("status", "in", ACTIVE_STATUSES);
		if (userId) query = query.where("userId", "=", userId);
		const result = await query.executeTakeFirst();
		return Number(result.numUpdatedRows ?? 0);
	}

	async getAsset(userId: string, assetId: string): Promise<ImageAssetRecord> {
		return this.requireAsset(this.database, userId, assetId);
	}

	async getAttempt(
		userId: string,
		attemptId: string,
	): Promise<ImageAttemptRecord> {
		return this.requireAttempt(this.database, userId, attemptId);
	}

	async readAsset(userId: string, assetId: string): Promise<ReadImageAsset> {
		const asset = await this.getAsset(userId, assetId);
		const bytes = await this.storage.read(asset.storageKey);
		return { asset, bytes };
	}

	async readAttempt(
		userId: string,
		attemptId: string,
	): Promise<ImageAttemptRecord> {
		return this.getAttempt(userId, attemptId);
	}

	async readAssetBytes(userId: string, assetId: string): Promise<Uint8Array> {
		return (await this.readAsset(userId, assetId)).bytes;
	}

	private async requireWorkspace(
		executor: Executor,
		userId: string,
		workspaceId: string,
	): Promise<ImageWorkspaceRecord> {
		const row = await executor
			.selectFrom("image_workspace")
			.selectAll()
			.where("id", "=", workspaceId)
			.where("userId", "=", userId)
			.executeTakeFirst();
		if (!row) throw new ImageNotFoundError("image workspace", workspaceId);
		return row;
	}

	private async requireAsset(
		executor: Executor,
		userId: string,
		assetId: string,
	): Promise<ImageAssetRecord> {
		const row = await executor
			.selectFrom("image_asset")
			.selectAll()
			.where("id", "=", assetId)
			.where("userId", "=", userId)
			.executeTakeFirst();
		if (!row) throw new ImageNotFoundError("image asset", assetId);
		return row;
	}

	private async requireAssetInWorkspace(
		executor: Executor,
		userId: string,
		workspaceId: string,
		assetId: string,
	): Promise<ImageAssetRecord> {
		const asset = await this.requireAsset(executor, userId, assetId);
		if (asset.workspaceId !== workspaceId)
			throw new ImageNotFoundError("image asset", assetId);
		return asset;
	}

	private async requireAttempt(
		executor: Executor,
		userId: string,
		attemptId: string,
	): Promise<ImageAttemptRecord> {
		const row = await executor
			.selectFrom("image_attempt")
			.selectAll()
			.where("id", "=", attemptId)
			.where("userId", "=", userId)
			.executeTakeFirst();
		if (!row) throw new ImageNotFoundError("image attempt", attemptId);
		return row;
	}
}

export const imageRepository = new ImageRepository(db, imageStorage);
