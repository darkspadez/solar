import { Hono, type Context } from "hono";
import { getSolarSession } from "../auth";
import {
	ImageConflictError,
	ImageNotFoundError,
	ImageWorkspaceStartedError,
} from "./repository";
import { imageGenerationService } from "./service";
import { ImageStorageError, imageStorage } from "./storage";

export const imageRoutes = new Hono();

async function userId(request: Request): Promise<string | null> {
	return (await getSolarSession(request.headers))?.user.id ?? null;
}

function assetUrl(workspaceId: string, assetId: string, download = false) {
	return `/api/images/${encodeURIComponent(workspaceId)}/assets/${encodeURIComponent(assetId)}${download ? "/download" : ""}`;
}

function safeFilename(filename: string): string {
	const normalized = filename.replace(/[\\/\r\n\0]/g, "_").trim();
	return normalized.slice(0, 180) || "solar-image";
}

function errorResponse(error: unknown) {
	if (error instanceof ImageNotFoundError)
		return new Response(JSON.stringify({ error: "not found" }), {
			status: 404,
			headers: { "content-type": "application/json" },
		});
	if (
		error instanceof ImageStorageError ||
		error instanceof ImageWorkspaceStartedError ||
		error instanceof ImageConflictError
	)
		return new Response(JSON.stringify({ error: error.message }), {
			status: 400,
			headers: { "content-type": "application/json" },
		});
	throw error;
}

imageRoutes.post("/:workspaceId/upload", async (c) => {
	const currentUserId = await userId(c.req.raw);
	if (!currentUserId) return c.json({ error: "unauthorized" }, 401);
	const file = (await c.req.parseBody()).file;
	if (!(file instanceof File))
		return c.json({ error: "file is required" }, 400);
	try {
		const asset = await imageGenerationService.uploadInitialImage(
			currentUserId,
			c.req.param("workspaceId"),
			{
				filename: safeFilename(file.name),
				mimeType: file.type,
				bytes: new Uint8Array(await file.arrayBuffer()),
			},
		);
		return c.json({
			id: asset.id,
			filename: asset.filename,
			mimeType: asset.mimeType,
			byteSize: asset.byteSize,
			width: asset.width,
			height: asset.height,
			url: assetUrl(c.req.param("workspaceId"), asset.id),
			downloadUrl: assetUrl(c.req.param("workspaceId"), asset.id, true),
		});
	} catch (error) {
		return errorResponse(error);
	}
});

async function serveAsset(c: Context, download: boolean): Promise<Response> {
	const currentUserId = await userId(c.req.raw);
	if (!currentUserId) return c.json({ error: "unauthorized" }, 401);
	try {
		const asset = await imageGenerationService.getAsset(
			currentUserId,
			c.req.param("assetId"),
		);
		if (asset.workspaceId !== c.req.param("workspaceId"))
			throw new ImageNotFoundError("image asset", c.req.param("assetId"));
		const bytes = await imageStorage.read(asset.storageKey);
		const headers = new Headers({
			"content-type": asset.mimeType,
			"cache-control": "private, no-store",
		});
		if (download)
			headers.set(
				"content-disposition",
				`attachment; filename="${safeFilename(asset.filename)}"`,
			);
		return new Response(bytes as unknown as BodyInit, { headers });
	} catch (error) {
		return errorResponse(error);
	}
}

imageRoutes.get("/:workspaceId/assets/:assetId", (c) => serveAsset(c, false));
imageRoutes.get("/:workspaceId/assets/:assetId/download", (c) =>
	serveAsset(c, true),
);
