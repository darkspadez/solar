import { beforeEach, describe, expect, mock, test } from "bun:test";

const roleUpdates: unknown[][] = [];
const keyDeletes: string[] = [];

mock.module("./db", () => ({
	sqlite: {
		query: (sql: string) => ({
			run: (...args: unknown[]) => {
				roleUpdates.push([sql, ...args]);
			},
			get: () => ({ count: 2 }),
		}),
	},
	db: {
		deleteFrom: () => ({
			where: (_column: string, _op: string, value: string) => ({
				execute: async () => {
					keyDeletes.push(value);
				},
			}),
		}),
	},
}));

const { applyUserRole, countActiveAdmins } = await import("./userRoles");

beforeEach(() => {
	roleUpdates.length = 0;
	keyDeletes.length = 0;
});

describe("applyUserRole", () => {
	test("revokes API keys when demoting, since only admins may use them", async () => {
		await applyUserRole("u1", "user");

		expect(roleUpdates).toEqual([
			["UPDATE user SET role = ? WHERE id = ?", "user", "u1"],
		]);
		expect(keyDeletes).toEqual(["u1"]);
	});

	test("keeps API keys when promoting", async () => {
		await applyUserRole("u1", "admin");

		expect(roleUpdates).toEqual([
			["UPDATE user SET role = ? WHERE id = ?", "admin", "u1"],
		]);
		expect(keyDeletes).toEqual([]);
	});
});

describe("countActiveAdmins", () => {
	test("reads the count of enabled admins", () => {
		expect(countActiveAdmins()).toBe(2);
	});
});
