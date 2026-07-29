import { sqlite } from "./db";

export const IMPERSONATION_TIMEOUT_MS = 30 * 60 * 1000;

export function getSolarImpersonation(adminSessionId: string) {
	const active = sqlite
		.query(
			"SELECT targetUserId, expiresAt FROM impersonation_session WHERE adminSessionId = ?",
		)
		.get(adminSessionId) as { targetUserId: string; expiresAt: number } | null;
	if (!active) return null;
	const now = Date.now();
	if (active.expiresAt <= now) {
		stopSolarImpersonation(adminSessionId);
		return null;
	}
	sqlite
		.query(
			"UPDATE impersonation_session SET expiresAt = ?, updatedAt = ? WHERE adminSessionId = ?",
		)
		.run(now + IMPERSONATION_TIMEOUT_MS, now, adminSessionId);
	return active;
}

export function startSolarImpersonation(
	adminSessionId: string,
	adminUserId: string,
	targetUserId: string,
) {
	const target = sqlite
		.query("SELECT id, name, email, role, isDisabled FROM user WHERE id = ?")
		.get(targetUserId) as {
		id: string;
		name: string;
		email: string;
		role: string;
		isDisabled: number;
	} | null;
	if (!target || target.isDisabled || target.id === adminUserId) return null;
	const now = Date.now();
	sqlite
		.query(
			"INSERT INTO impersonation_session (adminSessionId, targetUserId, expiresAt, updatedAt) VALUES (?, ?, ?, ?) ON CONFLICT(adminSessionId) DO UPDATE SET targetUserId = excluded.targetUserId, expiresAt = excluded.expiresAt, updatedAt = excluded.updatedAt",
		)
		.run(adminSessionId, targetUserId, now + IMPERSONATION_TIMEOUT_MS, now);
	return target;
}

export function stopSolarImpersonation(adminSessionId: string): void {
	sqlite
		.query("DELETE FROM impersonation_session WHERE adminSessionId = ?")
		.run(adminSessionId);
}
