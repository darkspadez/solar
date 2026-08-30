/**
 * Bulk pre-warm for the chat-v2 → pi migration
 * (docs/planning/pi-rpc-rewrite.md §Import of existing chats).
 *
 * Calls the same `importConversation` the live path uses — each conversation
 * is idempotent and independently verified, so a failure never blocks the
 * rest and re-running the script is always safe.
 *
 *   bun scripts/import-chat-v2-to-pi.ts [--concurrency 16] [--dry-run]
 *
 * Requires DATABASE_PATH/SOLAR_PI_AGENT_DIR to point at the deployment being
 * pre-warmed (same env the server runs with).
 */
import { parseArgs } from "node:util";
import { db } from "../apps/server/src/db";
import {
	importConversation,
	isPiSessionReady,
} from "../apps/server/src/pi/migration";

const { values } = parseArgs({
	args: Bun.argv,
	options: {
		concurrency: { type: "string", default: "16" },
		"dry-run": { type: "boolean", default: false },
	},
	strict: true,
	allowPositionals: true,
});

const concurrency = Math.max(1, Number(values.concurrency ?? "16"));
const dryRun = values["dry-run"] ?? false;

const rows = await db
	.selectFrom("v2_conversation")
	.select(["id", "userId"])
	.execute();

const total = rows.length;
let started = 0;
let already = 0;
let imported = 0;
let empty = 0;
const failures: Array<{ conversationId: string; error: string }> = [];

async function processConversation(row: { id: string; userId: string }) {
	if (dryRun) {
		if (isPiSessionReady(row.id)) already++;
		else imported++;
		return;
	}
	try {
		const result = await importConversation(row.userId, row.id);
		if (result.kind === "already") already++;
		else if (result.kind === "empty") empty++;
		else imported++;
	} catch (error) {
		failures.push({
			conversationId: row.id,
			error: error instanceof Error ? error.message : String(error),
		});
	}
}

const queue = [...rows];
async function worker() {
	while (queue.length) {
		const row = queue.shift()!;
		await processConversation(row);
		started++;
		if (started % 25 === 0) {
			console.log(
				`progress: ${started}/${total} (failures: ${failures.length})`,
			);
		}
	}
}

await Promise.all(
	Array.from({ length: Math.min(concurrency, total) }, () => worker()),
);

console.log("\nImport summary:");
console.log(`  total conversations : ${total}${dryRun ? " (dry run)" : ""}`);
console.log(`  already migrated    : ${already}`);
console.log(`  newly imported      : ${imported}`);
console.log(`  empty history       : ${empty}`);
console.log(`  failed              : ${failures.length}`);
for (const failure of failures) {
	console.error(`  FAIL ${failure.conversationId}: ${failure.error}`);
}
process.exitCode = failures.length ? 1 : 0;
