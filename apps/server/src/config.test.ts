import { describe, expect, test } from "bun:test";
import { isTruthy } from "./config";

describe("environment booleans", () => {
	test("recognizes explicit chat feature-flag values", () => {
		expect(isTruthy("1")).toBe(true);
		expect(isTruthy("true")).toBe(true);
		expect(isTruthy("TRUE")).toBe(true);
		expect(isTruthy("0")).toBe(false);
		expect(isTruthy("false")).toBe(false);
		expect(isTruthy(undefined)).toBe(false);
	});
});
