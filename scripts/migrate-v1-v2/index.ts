import { mkdir, rename, rm, stat } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { createHash } from "node:crypto";
import { Database as BunDatabase } from "bun:sqlite";
import { Kysely } from "kysely";
import { BunSqliteDialect } from "kysely-bun-sqlite";
import { up as upV2 } from "../../apps/server/src/db/migrations/020_chat_v2";
import { up as upOrganization } from "../../apps/server/src/db/migrations/021_chat_v2_organization";
import { up as upVoice } from "../../apps/server/src/db/migrations/022_chat_v2_voice";
import { materializeContext } from "../../apps/server/src/chat-v2/context";
import { projectVisibleTurns } from "../../apps/server/src/chat-v2/projection";
import { parseCanonicalMessage, validateMessageSequence, zeroUsage } from "../../apps/server/src/chat-v2/validation";

type Row = Record<string, any>;
type Issue = { code: string; detail: string; conversationId?: string; messageId?: string };
export type MigrationOptions = {
	sourceDb: string;
	sourceAssets: string;
	targetDb: string;
	targetAssets: string;
	reportPath: string;
	dryRun?: boolean;
	allowAmbiguousOrder?: boolean;
	force?: boolean;
	userMap?: Record<string, string>;
};
export type MigrationReport = {
	toolVersion: string;
	source: { path: string; sqliteVersion: string; migrationLevel: number | null };
	target: { path: string; assets: string };
	options: Omit<MigrationOptions, "sourceDb" | "sourceAssets" | "targetDb" | "targetAssets" | "reportPath">;
	counts: Record<string, number>;
	warnings: Issue[];
	recoveries: Issue[];
	failures: Issue[];
	mappings: Record<string, string[]>;
};
type PlannedMessage = { id: string; sourceId: string; conversationId: string; turnId: string; role: "user" | "assistant" | "toolResult"; message: any; origin: "text" | "voice" | "legacy"; status: string; createdAt: string };
type Plan = { conversations: Row[]; folders: Row[]; tags: Row[]; conversationTags: Row[]; messages: PlannedMessage[]; turns: Row[]; attachments: Row[]; generations: Row[] };
const TOOL_VERSION = "1.0.0";

function tableNames(db: BunDatabase): Set<string> { return new Set((db.query("select name from sqlite_master where type = 'table'").all() as Row[]).map((row) => row.name)); }
function rows(db: BunDatabase, table: string): Row[] { return db.query(`select * from "${table}"`).all() as Row[]; }
function iso(value: unknown): string | null { return typeof value === "string" && Number.isFinite(Date.parse(value)) ? value : null; }
function timestamp(value: unknown): number | null { const parsed = typeof value === "string" ? Date.parse(value) : NaN; return Number.isFinite(parsed) ? parsed : null; }
async function hashFile(path: string): Promise<string> { return createHash("sha256").update(new Uint8Array(await Bun.file(path).arrayBuffer())).digest("hex"); }
function stripSolar(value: any): any { if (!value || typeof value !== "object" || Array.isArray(value)) return value; const { solarToolCalls: _solarToolCalls, ...message } = value; return message; }
function syntheticAssistant(text: string, timestampValue: number, model: string | null): any { return { role: "assistant", content: [{ type: "text", text }], api: "openai-completions", provider: "solar-migration", model: model || "legacy", usage: zeroUsage(), stopReason: "stop", timestamp: timestampValue }; }
function issue(report: MigrationReport, kind: "warnings" | "recoveries" | "failures", code: string, detail: string, row?: Row) { report[kind].push({ code, detail, conversationId: row?.conversationId, messageId: row?.id }); }
function requiredTables(tables: Set<string>) { for (const table of ["user", "conversation", "message"]) if (!tables.has(table)) throw new Error(`source is not a v1 database: missing ${table}`); }

function convertAssistant(row: Row, steps: Row[], report: MigrationReport): any[] {
	const parsedParts = (() => { try { return row.parts ? stripSolar(JSON.parse(row.parts)) : null; } catch { issue(report, "failures", "invalid_parts_json", `message ${row.id} parts is not JSON`, row); return null; } })();
	if (row.status !== "complete") {
		const partial = parsedParts && (() => { try { return parseCanonicalMessage(parsedParts); } catch { return null; } })();
		if (!partial && row.parts) issue(report, "failures", "invalid_partial", `partial message ${row.id} is not a valid pi-ai message`, row);
		return [];
	}
	const result: any[] = [];
	for (const step of steps) {
		try { const message = parseCanonicalMessage(stripSolar(JSON.parse(step.data))); if (message.role !== "assistant" && message.role !== "toolResult") throw new Error("step is not assistant or toolResult"); result.push(message); }
		catch (error) { issue(report, "failures", "invalid_generation_step", `message ${row.id} step ${step.sequence}: ${error instanceof Error ? error.message : String(error)}`, row); }
	}
	if (parsedParts) {
		try {
			const terminal = parseCanonicalMessage(parsedParts);
			if (terminal.role !== "assistant") throw new Error("terminal payload is not assistant");
			const emitted = new Set(result.flatMap((message) => message.role === "assistant" ? message.content.filter((part: any) => part.type === "toolCall").map((part: any) => part.id) : []));
			const content = terminal.content.filter((part: any) => part.type !== "toolCall" || !emitted.has(part.id));
			if (content.length && !result.some((message) => message.role === "assistant" && JSON.stringify(message.content) === JSON.stringify(content))) result.push({ ...terminal, content });
		} catch (error) { issue(report, "failures", "invalid_assistant_payload", `message ${row.id}: ${error instanceof Error ? error.message : String(error)}`, row); }
	} else if (row.text) { result.push(syntheticAssistant(row.text, timestamp(row.createdAt) ?? 0, row.model)); issue(report, "recoveries", "legacy_assistant_text", `message ${row.id} used explicit synthetic legacy assistant payload`, row); }
	return result;
}

function planSource(source: BunDatabase, report: MigrationReport, options: MigrationOptions): Plan {
	const tables = tableNames(source); requiredTables(tables);
	const sourceMessages = rows(source, "message"); const steps = tables.has("generation_step") ? rows(source, "generation_step") : [];
	const conversations = rows(source, "conversation"); const messages: PlannedMessage[] = []; const turns: Row[] = []; const generations: Row[] = [];
	for (const conversation of conversations) {
		const list = sourceMessages.filter((message) => message.conversationId === conversation.id).sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)) || String(a.id).localeCompare(String(b.id)));
		const collision = new Set<string>(); for (const message of list) { const key = String(message.createdAt); if (list.filter((item) => item.createdAt === message.createdAt).length > 1) collision.add(key); }
		if (collision.size) { issue(report, "warnings", "timestamp_collision", `conversation ${conversation.id}: ${[...collision].join(", ")}`, conversation); if (!options.allowAmbiguousOrder) issue(report, "failures", "ambiguous_order", `conversation ${conversation.id} has timestamp collisions`, conversation); }
		for (const row of list) {
			const createdAt = iso(row.createdAt); if (!createdAt) { issue(report, "failures", "invalid_timestamp", `message ${row.id} has invalid createdAt`, row); continue; }
			const turnId = `v1-turn-${row.id}`; turns.push({ id: turnId, conversationId: row.conversationId, ordinal: turns.filter((turn) => turn.conversationId === row.conversationId).length, role: row.role, origin: "legacy", status: row.status === "complete" ? "complete" : "error", createdAt });
			let converted: any[] = [];
			if (row.role === "user") { const message = { role: "user", content: row.text, timestamp: timestamp(createdAt)! }; try { converted = [parseCanonicalMessage(message)]; } catch (error) { issue(report, "failures", "invalid_user", String(error), row); } }
			else if (row.role === "assistant") converted = convertAssistant(row, steps.filter((step) => step.messageId === row.id).sort((a, b) => a.sequence - b.sequence), report);
			else issue(report, "failures", "invalid_role", `message ${row.id} has role ${row.role}`, row);
			for (const [index, message] of converted.entries()) messages.push({ id: `v1-message-${row.id}-${index}`, sourceId: row.id, conversationId: row.conversationId, turnId, role: message.role, message, origin: "legacy", status: "complete", createdAt });
			if (row.role === "assistant" && row.status !== "complete") {
				const partial = (() => { try { return row.parts ? parseCanonicalMessage(stripSolar(JSON.parse(row.parts))) : null; } catch { return null; } })();
				generations.push({ id: `v1-generation-${row.id}`, conversationId: row.conversationId, turnId, status: row.status === "error" ? "failed" : "interrupted", provider: partial?.role === "assistant" ? partial.provider : "solar-migration", api: partial?.role === "assistant" ? partial.api : "openai-completions", model: partial?.role === "assistant" ? partial.model : row.model || "legacy", requestJson: JSON.stringify({ sourceMessageId: row.id }), partialMessageJson: partial ? JSON.stringify(partial) : null, usageJson: null, stopReason: null, errorMessage: row.status === "error" ? row.text || "legacy error" : "legacy generation interrupted", startedAt: createdAt, finishedAt: createdAt, createdAt });
			}
		}
		const sequence = messages.filter((message) => message.conversationId === conversation.id); try { validateMessageSequence(sequence.map((message) => message.message)); } catch (error) { issue(report, "failures", "tool_pairing", error instanceof Error ? error.message : String(error), conversation); }
	}
	if (tables.has("conversation_context_state") && rows(source, "conversation_context_state").some((row) => row.summary)) issue(report, "warnings", "compaction_omitted", "v1 rolling summaries were intentionally omitted");
	const candidateAttachments = tables.has("attachment") ? rows(source, "attachment").filter((attachment) => attachment.messageId) : [];
	// A broken referenced attachment (missing file or byte-size mismatch) is a
	// data-quality problem in the row itself, not something that should abort
	// migration of the rest of the conversation. It is omitted and reported,
	// never fabricated. A storage key that escapes the asset root is a
	// different, security-relevant class of anomaly and still aborts.
	const attachments: Row[] = [];
	for (const attachment of candidateAttachments) {
		const asset = resolve(options.sourceAssets, attachment.storageKey);
		const rel = relative(resolve(options.sourceAssets), asset);
		if (rel.startsWith("..") || !rel) { issue(report, "failures", "attachment_path", `attachment ${attachment.id} escapes source asset root`); continue; }
		if (!Bun.file(asset).size) { issue(report, "warnings", "attachment_omitted_missing_file", `attachment ${attachment.id} file missing; omitted from migration`); continue; }
		if (Bun.file(asset).size !== attachment.byteSize) { issue(report, "warnings", "attachment_omitted_size_mismatch", `attachment ${attachment.id} byte size differs; omitted from migration`); continue; }
		attachments.push(attachment);
	}
	if (tables.has("attachment")) for (const attachment of rows(source, "attachment").filter((attachment) => !attachment.messageId)) issue(report, "warnings", "orphan_attachment_omitted", `attachment ${attachment.id} is unreferenced`);
	return { conversations, folders: tables.has("folder") ? rows(source, "folder") : [], tags: tables.has("tag") ? rows(source, "tag") : [], conversationTags: tables.has("conversation_tag") ? rows(source, "conversation_tag") : [], messages, turns, attachments, generations };
}

async function createTarget(path: string, source: BunDatabase): Promise<{ sqlite: BunDatabase; db: Kysely<any> }> {
	const sqlite = new BunDatabase(path, { create: true }); sqlite.exec("PRAGMA foreign_keys = ON");
	const db = new Kysely({ dialect: new BunSqliteDialect({ database: sqlite }) });
	const userSql = (source.query("select sql from sqlite_master where type='table' and name='user'").get() as Row | null)?.sql;
	if (!userSql) throw new Error("source user table definition is missing"); sqlite.exec(userSql);
	await upV2(db as any); await upOrganization(db as any); await upVoice(db as any); return { sqlite, db };
}

async function writeTarget(path: string, source: BunDatabase, plan: Plan, options: MigrationOptions) {
	const { sqlite, db } = await createTarget(path, source); const targetUsers = new Set(Object.values(options.userMap ?? {}));
	try {
		await db.transaction().execute(async (trx: any) => {
			const userRows = rows(source, "user"); for (const user of userRows) { const mapped = options.userMap?.[user.id] ?? user.id; targetUsers.add(mapped); const clone = { ...user, id: mapped }; await trx.insertInto("user").values(clone).execute(); }
			for (const folder of plan.folders) await trx.insertInto("v2_folder").values({ ...folder, userId: options.userMap?.[folder.userId] ?? folder.userId }).execute();
			for (const tag of plan.tags) await trx.insertInto("v2_tag").values({ ...tag, userId: options.userMap?.[tag.userId] ?? tag.userId }).execute();
			for (const conversation of plan.conversations) await trx.insertInto("v2_conversation").values({ id: conversation.id, userId: options.userMap?.[conversation.userId] ?? conversation.userId, title: conversation.title, folderId: conversation.folderId ?? null, provider: conversation.provider ?? null, endpointId: conversation.endpointId ?? null, modelId: conversation.modelId ?? null, modelApi: conversation.modelApi ?? null, systemPrompt: conversation.systemPrompt ?? null, generationConfigJson: "{}", createdAt: conversation.createdAt, updatedAt: conversation.updatedAt }).execute();
			for (const turn of plan.turns) await trx.insertInto("v2_conversation_turn").values(turn).execute();
			for (const [ordinal, message] of plan.messages.entries()) await trx.insertInto("v2_conversation_message").values({ id: message.id, conversationId: message.conversationId, turnId: message.turnId, ordinal, role: message.role, messageJson: JSON.stringify(message.message), origin: message.origin, status: message.status, createdAt: message.createdAt }).execute();
			for (const generation of plan.generations) await trx.insertInto("v2_generation").values(generation).execute();
			for (const binding of plan.conversationTags) await trx.insertInto("v2_conversation_tag").values(binding).execute();
			const attachmentOrdinals = new Map<string, number>();
			for (const attachment of plan.attachments) { const sourceMessage = plan.messages.find((message) => message.sourceId === attachment.messageId); if (!sourceMessage) continue; const sha256 = await hashFile(resolve(options.sourceAssets, attachment.storageKey)); await trx.insertInto("v2_attachment").values({ id: attachment.id, userId: options.userMap?.[attachment.userId] ?? attachment.userId, storageKey: attachment.storageKey, filename: attachment.filename, mimeType: attachment.mimeType, kind: attachment.kind, byteSize: attachment.byteSize, sha256, width: attachment.width ?? null, height: attachment.height ?? null, pageCount: attachment.pageCount ?? null, createdAt: attachment.createdAt }).execute(); const ordinal = attachmentOrdinals.get(sourceMessage.id) ?? 0; attachmentOrdinals.set(sourceMessage.id, ordinal + 1); await trx.insertInto("v2_message_attachment").values({ messageId: sourceMessage.id, attachmentId: attachment.id, ordinal }).execute(); }
		});
		return { sqlite, db };
	} catch (error) { await db.destroy(); sqlite.close(); throw error; }
}

async function verify(sqlite: BunDatabase, db: Kysely<any>, plan: Plan, report: MigrationReport) {
	const integrity = sqlite.query("pragma integrity_check").all() as Row[]; if (integrity.some((row) => row.integrity_check !== "ok")) issue(report, "failures", "integrity_check", JSON.stringify(integrity));
	const foreignKeys = sqlite.query("pragma foreign_key_check").all(); if (foreignKeys.length) issue(report, "failures", "foreign_key_check", JSON.stringify(foreignKeys));
	for (const conversation of plan.conversations.slice(0, 5)) { const records: any[] = (await db.selectFrom("v2_conversation_message").selectAll().where("conversationId", "=", conversation.id).orderBy("ordinal").execute()).map((row: Row) => ({ ...row, message: JSON.parse(row.messageJson) })); try { validateMessageSequence(records.map((record) => record.message)); projectVisibleTurns(records); materializeContext(conversation.id, records, []); } catch (error) { issue(report, "failures", "reconstruction", error instanceof Error ? error.message : String(error), conversation); } }
}

export async function runMigration(options: MigrationOptions): Promise<MigrationReport> {
	const source = new BunDatabase(options.sourceDb, { readonly: true });
	const report: MigrationReport = { toolVersion: TOOL_VERSION, source: { path: options.sourceDb, sqliteVersion: String((source.query("select sqlite_version() as version").get() as Row).version), migrationLevel: tableNames(source).has("kysely_migration") ? rows(source, "kysely_migration").length : null }, target: { path: options.targetDb, assets: options.targetAssets }, options: { dryRun: options.dryRun, allowAmbiguousOrder: options.allowAmbiguousOrder, force: options.force, userMap: options.userMap }, counts: {}, warnings: [], recoveries: [], failures: [], mappings: {} };
	try {
		const plan = planSource(source, report, options); report.counts = { conversations: plan.conversations.length, turns: plan.turns.length, messages: plan.messages.length, attachments: plan.attachments.length, generations: plan.generations.length }; for (const message of plan.messages) (report.mappings[message.sourceId] ??= []).push(message.id);
		if (!options.dryRun && !report.failures.length) {
			if (Bun.file(options.targetDb).size && !options.force) throw new Error("target database exists; pass --force to replace it");
			const stageDb = `${options.targetDb}.staging`; const stageAssets = `${options.targetAssets}.staging`; await rm(stageDb, { force: true }); await rm(stageAssets, { recursive: true, force: true }); await mkdir(stageAssets, { recursive: true });
			for (const attachment of plan.attachments) { const sourcePath = resolve(options.sourceAssets, attachment.storageKey); const destination = resolve(stageAssets, attachment.storageKey); await mkdir(dirname(destination), { recursive: true }); await Bun.write(destination, new Uint8Array(await Bun.file(sourcePath).arrayBuffer())); const copied = await stat(destination); if (copied.size !== attachment.byteSize || await hashFile(sourcePath) !== await hashFile(destination)) throw new Error(`attachment ${attachment.id} staging hash mismatch`); }
			const target = await writeTarget(stageDb, source, plan, options); await verify(target.sqlite, target.db, plan, report); await target.db.destroy(); target.sqlite.close(); if (report.failures.length) { await rm(stageDb, { force: true }); await rm(stageAssets, { recursive: true, force: true }); } else { if (options.force) { await rm(options.targetDb, { force: true }); await rm(options.targetAssets, { recursive: true, force: true }); } await mkdir(dirname(options.targetDb), { recursive: true }); await rename(stageDb, options.targetDb); await rename(stageAssets, options.targetAssets); }
		}
	} catch (error) { issue(report, "failures", "migration_error", error instanceof Error ? error.message : String(error)); }
	finally { source.close(); await mkdir(dirname(options.reportPath), { recursive: true }); await Bun.write(options.reportPath, JSON.stringify(report, null, 2)); }
	return report;
}
