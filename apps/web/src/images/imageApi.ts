import type {
	UseMutationOptions,
	UseQueryOptions,
} from "@tanstack/react-query";

export interface ImageAsset {
	id: string;
	url?: string | null;
	imageUrl?: string | null;
	thumbnailUrl?: string | null;
	downloadUrl?: string | null;
	mimeType?: string | null;
	prompt?: string | null;
	createdAt?: string | null;
	width?: number | null;
	height?: number | null;
	sourceVariantId?: string | null;
}

export interface ImageAttempt {
	id: string;
	status:
		| "queued"
		| "running"
		| "completed"
		| "failed"
		| "interrupted"
		| string;
	error?: string | null;
	errorMessage?: string | null;
	prompt?: string | null;
	createdAt?: string | null;
	costMicros?: number | null;
	asset?: ImageAsset | null;
	result?: ImageAsset | null;
}

export interface ImageWorkspaceSummary {
	id: string;
	title: string;
	createdAt?: string | null;
	updatedAt?: string | null;
	thumbnailUrl?: string | null;
	status?: string | null;
}

export interface ImageWorkspace extends ImageWorkspaceSummary {
	assets?: ImageAsset[];
	variants?: ImageAsset[];
	attempts?: ImageAttempt[];
	currentAssetId?: string | null;
	activeAttempt?: ImageAttempt | null;
}

export interface ImageModel {
	id?: string;
	modelId?: string;
	name?: string;
	displayName?: string;
	aspectRatios?: string[];
	resolutions?: string[];
	input?: ("text" | "image")[];
	output?: ("text" | "image")[];
}

export interface ImageCreateInput {
	title?: string;
}

export interface ImageGenerateInput {
	workspaceId: string;
	sourceAssetId?: string | null;
	prompt: string;
	modelId: string;
	aspectRatio: string;
	resolution: string;
	requestKey?: string;
}

export interface ImageRetryInput {
	attemptId: string;
}

export interface ImageRemoveInput {
	workspaceId: string;
}

type QueryProcedure<TInput, TOutput> = {
	queryOptions: (
		input?: TInput,
		options?: { enabled?: boolean },
	) => UseQueryOptions<TOutput, Error>;
	queryKey: (input?: TInput) => readonly unknown[];
};

type MutationProcedure<TInput, TOutput> = {
	mutationOptions: (
		options?: UseMutationOptions<TOutput, Error, TInput>,
	) => UseMutationOptions<TOutput, Error, TInput>;
};

export interface ImageTrpcRouter {
	list: QueryProcedure<void, ImageWorkspaceSummary[]>;
	get: QueryProcedure<{ workspaceId: string }, ImageWorkspace>;
	models: QueryProcedure<void, ImageModel[]>;
	create: MutationProcedure<ImageCreateInput, { id: string; title?: string }>;
	generate: MutationProcedure<ImageGenerateInput, ImageAttempt>;
	retry: MutationProcedure<ImageRetryInput, ImageAttempt>;
	remove: MutationProcedure<ImageRemoveInput, unknown>;
}

/**
 * Image routes are intentionally kept behind this local contract until the
 * server image router lands. The cast preserves the same typed hook shape as
 * the rest of the app without coupling the web build to an unfinished router.
 */
export function getImageTrpc(trpc: unknown): ImageTrpcRouter {
	return (trpc as { image: ImageTrpcRouter }).image;
}

export function imageUrl(asset: ImageAsset | null | undefined): string | null {
	return asset?.url ?? asset?.imageUrl ?? asset?.thumbnailUrl ?? null;
}
