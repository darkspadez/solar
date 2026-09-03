import { db, sqlite } from "./db";

export type UserRole = "admin" | "user";

/**
 * Number of admins who can still sign in. Demoting or disabling the last one
 * would lock everybody out of the admin surface, so every path that removes
 * admin access checks this first.
 */
export function countActiveAdmins(): number {
	const row = sqlite
		.query(
			"SELECT COUNT(*) AS count FROM user WHERE role = 'admin' AND isDisabled = 0",
		)
		.get() as { count: number };
	return row.count;
}

/**
 * Writes a user's role, revoking their API keys on demotion because keys
 * authenticate as their owner and only admins may use them (`getSolarSession`).
 *
 * Callers own their own authorization and last-admin checks; this helper exists
 * so the admin mutation and OIDC claim sync cannot drift apart.
 */
export async function applyUserRole(
	userId: string,
	role: UserRole,
): Promise<void> {
	sqlite.query("UPDATE user SET role = ? WHERE id = ?").run(role, userId);
	if (role === "user")
		await db.deleteFrom("apikey").where("referenceId", "=", userId).execute();
}
