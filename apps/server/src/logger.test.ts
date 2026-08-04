import { afterAll, describe, expect, mock, test } from "bun:test";

const originalDebug = console.debug;
const originalTrace = console.trace;
const debug = mock(() => {});
const trace = mock(() => {});

console.debug = debug as typeof console.debug;
console.trace = trace as typeof console.trace;

const { logger, setLogLevel } = await import("./logger");

afterAll(() => {
	console.debug = originalDebug;
	console.trace = originalTrace;
});

describe("structured logger trace output", () => {
	test("uses debug without emitting a native console trace stack", () => {
		setLogLevel("trace");
		debug.mockClear();
		trace.mockClear();

		logger.withMetadata({ component: "test" }).trace("trace message");

		expect(debug).toHaveBeenCalledTimes(1);
		expect(trace).not.toHaveBeenCalled();
	});
});
