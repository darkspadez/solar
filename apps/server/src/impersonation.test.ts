import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

const sqlite = new Database(":memory:");
mock.module("./db", () => ({ sqlite }));

const {
	IMPERSONATION_TIMEOUT_MS,
	getSolarImpersonation,
	startSolarImpersonation,
	stopSolarImpersonation,
} = await import("./impersonation");

describe("impersonation sessions", () => {
	beforeEach(() => {
		sqlite.exec(`
			DROP TABLE IF EXISTS user;
			DROP TABLE IF EXISTS impersonation_session;
			CREATE TABLE user (
				id TEXT PRIMARY KEY,
				name TEXT NOT NULL,
				email TEXT NOT NULL,
				role TEXT NOT NULL,
				isDisabled INTEGER NOT NULL
			);
			CREATE TABLE impersonation_session (
				adminSessionId TEXT PRIMARY KEY,
				targetUserId TEXT NOT NULL,
				expiresAt INTEGER NOT NULL,
				updatedAt INTEGER NOT NULL
			);
		`);
		sqlite
			.query("INSERT INTO user VALUES (?, ?, ?, ?, ?)")
			.run("admin", "Admin", "admin@example.com", "admin", 0);
		sqlite
			.query("INSERT INTO user VALUES (?, ?, ?, ?, ?)")
			.run("user", "User", "user@example.com", "user", 0);
		sqlite
			.query("INSERT INTO user VALUES (?, ?, ?, ?, ?)")
			.run("disabled", "Disabled", "disabled@example.com", "user", 1);
	});

	afterEach(() => sqlite.exec("DELETE FROM impersonation_session"));

	test("starts, refreshes, and stops a session for an active target", () => {
		const target = startSolarImpersonation("session-1", "admin", "user");
		expect(target).toMatchObject({ id: "user", email: "user@example.com" });

		const active = getSolarImpersonation("session-1");
		expect(active?.targetUserId).toBe("user");
		expect(active?.expiresAt).toBeGreaterThan(Date.now());

		stopSolarImpersonation("session-1");
		expect(getSolarImpersonation("session-1")).toBeNull();
	});

	test("rejects self-impersonation and disabled targets", () => {
		expect(startSolarImpersonation("session-1", "admin", "admin")).toBeNull();
		expect(
			startSolarImpersonation("session-1", "admin", "disabled"),
		).toBeNull();
		expect(getSolarImpersonation("session-1")).toBeNull();
	});

	test("expires an inactive session and removes it", () => {
		const now = Date.now();
		sqlite
			.query("INSERT INTO impersonation_session VALUES (?, ?, ?, ?)")
			.run("session-1", "user", now - 1, now - IMPERSONATION_TIMEOUT_MS);

		expect(getSolarImpersonation("session-1")).toBeNull();
		expect(
			sqlite
				.query("SELECT * FROM impersonation_session WHERE adminSessionId = ?")
				.get("session-1"),
		).toBeNull();
	});
});
