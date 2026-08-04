import { LogLayer, StructuredTransport, type LogLevelType } from "loglayer";
import { serializeError } from "serialize-error";

const LOG_LEVELS = ["trace", "debug", "info", "warn", "error"] as const;
export type SolarLogLevel = (typeof LOG_LEVELS)[number];

// StructuredTransport maps its trace level to the supplied logger's
// `trace()` method. The native console.trace() method also emits a call stack,
// which turns ordinary trace logs into noisy stack traces (especially for
// expected Socket.IO disconnects). Keep the structured level while using
// console.debug() for trace output.
const structuredConsole = {
	...console,
	trace: console.debug.bind(console),
};

function initialLevel(): SolarLogLevel {
	if (process.env.SOLAR_SEED_DEV_USER === "1") return "trace";
	const value = process.env.SOLAR_LOG_LEVEL;
	if (value && LOG_LEVELS.includes(value as SolarLogLevel))
		return value as SolarLogLevel;
	return process.env.NODE_ENV === "production" ? "info" : "debug";
}

let level = initialLevel();

export const logger = new LogLayer({
	errorSerializer: serializeError,
	transport: new StructuredTransport({ logger: structuredConsole }),
});

logger.setLevel(level);

export function getLogLevel(): SolarLogLevel {
	return level;
}

export function setLogLevel(nextLevel: SolarLogLevel): void {
	level = nextLevel;
	logger.setLevel(nextLevel as LogLevelType);
	logger.info(`log level changed to ${nextLevel}`);
}
