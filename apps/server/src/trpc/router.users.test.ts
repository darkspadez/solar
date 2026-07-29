import { beforeEach, describe, expect, mock, test } from "bun:test";

let passwordResult = true;
const passwordChanges: { userId: string; password: string }[] = [];
const impersonationCalls: string[] = [];

mock.module("../db", () => ({
	db: {},
	sqlite: {},
}));
mock.module("../auth", () => ({
	createSolarApiKey: async () => ({ id: "key", key: "sk_solar_test" }),
	createSolarUser: async () => {},
	setSolarUserPassword: async (userId: string, password: string) => {
		passwordChanges.push({ userId, password });
		return passwordResult;
	},
}));
mock.module("../impersonation", () => ({
	startSolarImpersonation: (
		_sessionId: string,
		_adminUserId: string,
		targetUserId: string,
	) => {
		impersonationCalls.push(`start:${targetUserId}`);
		return { name: "Target", email: "target@example.com" };
	},
	stopSolarImpersonation: (sessionId: string) => {
		impersonationCalls.push(`stop:${sessionId}`);
	},
}));
mock.module("../chat/attachments", () => ({
	deleteAttachmentFilesForMessages: async () => {},
	deleteAttachmentFilesForUser: async () => {},
	deleteAttachmentFilesByStorageKey: async () => {},
	expandAttachmentRows: async () => ({ parts: [], documents: [] }),
}));

const { appRouter } = await import("./router");

describe("admin user password changes", () => {
	beforeEach(() => {
		passwordResult = true;
		passwordChanges.length = 0;
		impersonationCalls.length = 0;
	});

	test("allows an admin to change their own password", async () => {
		const caller = appRouter.createCaller({
			user: { id: "admin", role: "admin" },
		} as never);

		await caller.admin.setUserPassword({
			userId: "admin",
			password: "new-password",
		});

		expect(passwordChanges).toEqual([
			{ userId: "admin", password: "new-password" },
		]);
	});

	test("allows an admin to change another user's password", async () => {
		const caller = appRouter.createCaller({
			user: { id: "admin", role: "admin" },
		} as never);

		await caller.admin.setUserPassword({
			userId: "user",
			password: "replacement-password",
		});

		expect(passwordChanges).toEqual([
			{ userId: "user", password: "replacement-password" },
		]);
	});

	test("rejects non-admin users", async () => {
		const caller = appRouter.createCaller({
			user: { id: "user", role: "user" },
		} as never);

		expect(
			caller.admin.setUserPassword({
				userId: "user",
				password: "new-password",
			}),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		expect(passwordChanges).toEqual([]);
	});

	test("rejects anonymous users", async () => {
		const caller = appRouter.createCaller({ user: null } as never);

		expect(
			caller.admin.setUserPassword({
				userId: "user",
				password: "new-password",
			}),
		).rejects.toMatchObject({ code: "UNAUTHORIZED" });
		expect(passwordChanges).toEqual([]);
	});

	test("returns not found for an unknown user", async () => {
		passwordResult = false;
		const caller = appRouter.createCaller({
			user: { id: "admin", role: "admin" },
		} as never);

		expect(
			caller.admin.setUserPassword({
				userId: "missing",
				password: "new-password",
			}),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
	});

	test("allows an admin with a session to impersonate another user", async () => {
		const caller = appRouter.createCaller({
			user: { id: "admin", role: "admin" },
			session: { id: "admin-session", userId: "admin" },
		} as never);

		await caller.admin.startImpersonation({ userId: "user" });
		expect(impersonationCalls).toEqual(["start:user"]);
	});

	test("rejects impersonation without a session or from a non-admin", async () => {
		const noSession = appRouter.createCaller({
			user: { id: "admin", role: "admin" },
			session: null,
		} as never);
		await expect(
			noSession.admin.startImpersonation({ userId: "user" }),
		).rejects.toMatchObject({ code: "UNAUTHORIZED" });

		const user = appRouter.createCaller({
			user: { id: "user", role: "user" },
			session: { id: "user-session", userId: "user" },
		} as never);
		await expect(
			user.admin.startImpersonation({ userId: "other" }),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		expect(impersonationCalls).toEqual([]);
	});

	test("allows an impersonated user to stop impersonating", async () => {
		const caller = appRouter.createCaller({
			user: { id: "user", role: "user" },
			session: { id: "admin-session", userId: "admin" },
		} as never);

		await caller.admin.stopImpersonation();
		expect(impersonationCalls).toEqual(["stop:admin-session"]);
	});
});
