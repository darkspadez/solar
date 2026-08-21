/**
 * Per-spawn bearer tokens for the /internal/pi-bridge/* surface.
 *
 * A token is generated when a pi child process is spawned, passed to it via
 * env, and held only in that process's memory — never persisted, never sent
 * to the browser. It authenticates the child's callbacks (tool list/execute,
 * attachment expansion) to exactly one conversation for one live session.
 */
import { randomUUID } from "node:crypto";
import type { UserLocation } from "../../chat/builtins";

export interface BridgeIdentity {
	conversationId: string;
	userId: string;
	userLocation?: UserLocation;
}

const tokens = new Map<string, BridgeIdentity>();

export function issueBridgeToken(identity: BridgeIdentity): string {
	const token = randomUUID();
	tokens.set(token, identity);
	return token;
}

export function resolveBridgeToken(token: string): BridgeIdentity | null {
	return tokens.get(token) ?? null;
}

export function revokeBridgeToken(token: string): void {
	tokens.delete(token);
}
