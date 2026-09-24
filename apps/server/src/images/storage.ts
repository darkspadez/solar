import { DiskResource, PathSpec } from "@struktoai/mirage-node";
import { config } from "../config";

export const MAX_IMAGE_BYTES = 16 * 1024 * 1024;

const UUID_REGEX =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const SUPPORTED_MIME_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);

export class ImageStorageError extends Error {}

export class ImageStorage {
	readonly root: string;
	private disk: DiskResource;
	private opened: Promise<void> | null = null;

	constructor(root: string = config.attachmentsDataDir) {
		this.root = root;
		this.disk = new DiskResource({ root: this.root });
	}

	private async ensureOpen(): Promise<void> {
		if (!this.opened) {
			this.opened = this.disk.open();
		}
		await this.opened;
	}

	private validateId(id: string, name: string): void {
		if (!UUID_REGEX.test(id)) {
			throw new ImageStorageError(`Invalid ${name} UUID: ${id}`);
		}
	}

	private verifyMagicBytes(bytes: Uint8Array, mimeType: string): void {
		if (mimeType === "image/png") {
			if (
				bytes.byteLength < 8 ||
				bytes[0] !== 0x89 ||
				bytes[1] !== 0x50 ||
				bytes[2] !== 0x4e ||
				bytes[3] !== 0x47 ||
				bytes[4] !== 0x0d ||
				bytes[5] !== 0x0a ||
				bytes[6] !== 0x1a ||
				bytes[7] !== 0x0a
			) {
				throw new ImageStorageError(
					"File contents do not match PNG magic bytes",
				);
			}
		} else if (mimeType === "image/jpeg") {
			if (
				bytes.byteLength < 3 ||
				bytes[0] !== 0xff ||
				bytes[1] !== 0xd8 ||
				bytes[2] !== 0xff
			) {
				throw new ImageStorageError(
					"File contents do not match JPEG magic bytes",
				);
			}
		} else if (mimeType === "image/webp") {
			if (
				bytes.byteLength < 12 ||
				bytes[0] !== 0x52 ||
				bytes[1] !== 0x49 ||
				bytes[2] !== 0x46 ||
				bytes[3] !== 0x46 ||
				bytes[8] !== 0x57 ||
				bytes[9] !== 0x45 ||
				bytes[10] !== 0x42 ||
				bytes[11] !== 0x50
			) {
				throw new ImageStorageError(
					"File contents do not match WebP magic bytes",
				);
			}
		} else {
			throw new ImageStorageError(`Unsupported image MIME type: ${mimeType}`);
		}
	}

	async save(
		workspaceId: string,
		assetId: string,
		bytes: Uint8Array,
		mimeType: string,
	): Promise<{
		storageKey: string;
		mimeType: string;
		byteSize: number;
		width: number;
		height: number;
		sha256: string;
	}> {
		this.validateId(workspaceId, "workspaceId");
		this.validateId(assetId, "assetId");

		if (!SUPPORTED_MIME_TYPES.has(mimeType)) {
			throw new ImageStorageError(`Unsupported MIME type: ${mimeType}`);
		}
		if (bytes.byteLength === 0) {
			throw new ImageStorageError("Image data is empty");
		}
		if (bytes.byteLength > MAX_IMAGE_BYTES) {
			throw new ImageStorageError("Image exceeds 16 MiB size limit");
		}

		this.verifyMagicBytes(bytes, mimeType);

		let width: number;
		let height: number;
		try {
			const meta = await new Bun.Image(bytes).metadata();
			if (
				typeof meta.width !== "number" ||
				typeof meta.height !== "number" ||
				meta.width <= 0 ||
				meta.height <= 0
			) {
				throw new Error("Non-positive or missing dimensions");
			}
			width = meta.width;
			height = meta.height;
		} catch (err) {
			throw new ImageStorageError(
				`Failed to read image dimensions: ${err instanceof Error ? err.message : String(err)}`,
			);
		}

		await this.ensureOpen();

		const storageKey = `images/${workspaceId}/${assetId}`;
		const stagingKey = `images/${workspaceId}/.tmp-${assetId}-${crypto.randomUUID()}`;

		const dirPath = PathSpec.fromStrPath(`/images/${workspaceId}`);
		await this.disk.mkdir(dirPath, { recursive: true });

		const stagingPath = PathSpec.fromStrPath(`/${stagingKey}`);
		const finalPath = PathSpec.fromStrPath(`/${storageKey}`);

		await this.disk.writeFile(stagingPath, bytes);
		try {
			await this.disk.rename(stagingPath, finalPath);
		} catch (err) {
			await this.disk.unlink(stagingPath).catch(() => {});
			throw err;
		}

		const sha256Buffer = await crypto.subtle.digest(
			"SHA-256",
			bytes as unknown as BufferSource,
		);
		const sha256 = Buffer.from(sha256Buffer).toString("hex");

		return {
			storageKey,
			mimeType,
			byteSize: bytes.byteLength,
			width,
			height,
			sha256,
		};
	}

	async read(storageKey: string): Promise<Uint8Array> {
		await this.ensureOpen();
		return this.disk.readFile(PathSpec.fromStrPath(`/${storageKey}`));
	}

	async remove(storageKeys: readonly string[]): Promise<void> {
		if (storageKeys.length === 0) return;
		await this.ensureOpen();
		for (const key of storageKeys) {
			const p = PathSpec.fromStrPath(`/${key}`);
			try {
				const exists = await this.disk.exists(p);
				if (exists) {
					await this.disk.unlink(p);
				}
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				const code = (err as { code?: string }).code;
				if (
					code === "ENOENT" ||
					msg.includes("ENOENT") ||
					msg.includes("not found") ||
					msg.includes("No such file")
				) {
					// Ignore ENOENT / not found
					continue;
				}
				throw err;
			}
		}
	}

	async removeWorkspace(workspaceId: string): Promise<void> {
		this.validateId(workspaceId, "workspaceId");
		await this.ensureOpen();
		const p = PathSpec.fromStrPath(`/images/${workspaceId}`);
		try {
			const exists = await this.disk.exists(p);
			if (exists) {
				await this.disk.rmR(p);
			}
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			const code = (err as { code?: string }).code;
			if (
				code === "ENOENT" ||
				msg.includes("ENOENT") ||
				msg.includes("not found") ||
				msg.includes("No such file")
			) {
				return;
			}
			throw err;
		}
	}
}

export const imageStorage = new ImageStorage();
