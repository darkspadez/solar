# Solar as an RPC Client to pi-coding-agent

> **Implementation status:** This rewrite is implemented on the current branch.
> The live engine is under `apps/server/src/pi/`; chat-v2 remains only as a
> legacy archive, migration, and export layer. The design and rollout notes
> below are retained as the implementation record.

## Objective

Replace Solar's hand-rolled message ordering, compaction, and branching
(`apps/server/src/chat-v2/`, `apps/server/src/chat/generationManager.ts`) with
a thin bridge to `@earendil-works/pi-coding-agent`, which already owns a more
capable version of the same machinery (append-only session trees,
compaction, branch summarization, model/thinking-level state) and ships it as
both a spawnable RPC process (`pi --mode rpc`) *and* a directly importable
library (`@earendil-works/pi-coding-agent`'s main export: `SessionManager`,
`parseSessionEntries`, `buildSessionContext`, `ModelRuntime`, `RpcClient`,
etc. — all public, not deep imports).

Validated by a working spike (since removed from the tree): Solar spawned a
real `pi --mode rpc` process, injected a Solar-authored tool via an extension
file, streamed a full prompt/tool-call/response cycle over SSE, and confirmed
pi retained conversation state across two separate HTTP requests with zero
history passed by Solar. `GET .../state` returned a real on-disk JSONL
session file managed entirely by pi.

Solar's retained, differentiated surface: web UI, multi-user auth, MCP/tool
configuration, presets, attachments/citations, voice. None of that changes
shape; it moves from talking to `pi-ai`/`pi-agent-core` directly to talking to
pi's session files and, only when actually generating, a `pi` process.

## Core principle: pi's JSONL is canonical, Solar's SQLite is not a second copy

This is the central design constraint of the rewrite, stated once so every
section below can be checked against it: **a conversation's message content
lives in exactly one place — its JSONL session file.** Solar's SQLite exists
only for two kinds of data:

1. **Facts pi cannot know**: user ownership, folders/tags, presets, MCP
   server/skill configuration, auth, admin settings. These are genuinely
   Solar's data and always will be.
2. **Disposable, rebuildable caches** of data that is fully re-derivable from
   JSONL at any time — the exact pattern `chat-v2/search.ts` already uses
   today (`rebuildSearchProjection`'s own docstring: "Rebuildable,
   non-authoritative search projection derived from canonical payloads").
   This rewrite generalizes that pattern instead of introducing new
   independent tables that quietly become a second source of truth.

The practical consequence: **most "read" operations need no SQL mirror and
no spawned process at all.** `@earendil-works/pi-coding-agent`'s
`SessionManager`, `parseSessionEntries`, `buildSessionContext`,
`ModelRuntime`, and `ModelRegistry` are ordinary library exports Solar can
call in-process against a session file or `SOLAR_PI_AGENT_DIR` directly.
Spawning an actual `pi --mode rpc` child process (via pi's own exported
`RpcClient`, not the spike's hand-rolled bridge) is reserved for the one
thing that genuinely requires a live agent loop: **producing a new
assistant turn** (prompt/steer/abort, tool execution, auto-compaction
decisions). Listing conversations, rendering a transcript, searching,
exporting, computing usage, and listing available models are all direct,
synchronous library reads. This eliminates an entire class of "keep the
SQLite mirror in sync with the live event stream" problems this plan
previously had.

## Non-goals

- Backward compatibility shims, dual-write, or a feature-flagged coexistence
  period longer than the single cutover described in Rollout.
- Preserving `chat-v2`'s SQLite schema, validation contracts (`FREEZE.md`), or
  its compaction job queue as anything but an import source.
- Any change to `apps/web` beyond what's needed for the SSE event shape (the
  UI Message Stream contract to assistant-ui does not change).
- Multi-region/HA process orchestration for `pi` — single-node, one `pi`
  process per actively-generating conversation, same as the spike.

## Current seams (chat-v2 / chat) being replaced

- `chat-v2/db/repository.ts`, `chat-v2/projection.ts` — canonical message
  storage/ordering → replaced by pi's `SessionManager` (JSONL tree),
  read directly as a library, no SQL mirror.
- `chat-v2/compaction.ts`, `chat-v2/compactionScheduler.ts` — DB-backed
  compaction job queue → replaced by pi's `core/compaction/` (compact +
  branch-summary-on-navigate, which chat-v2 doesn't have at all).
- `chat-v2/edit.ts` — branch-by-copy-and-truncate → pi's in-process tree
  navigation. **Decision (refined during implementation):** the branch
  pointer is process-local in pi and not persisted to JSONL, so edits
  cannot be effected by Solar mutating the file with the library API.
  Instead the bridge extension registers a `/solar-reprompt <json>`
  command that runs `ctx.navigateTree(parentOf(target))` + sends the
  (edited or re-issued) prompt inside the child process — the abandoned
  path stays on disk, inert, and the UI continues to render only the
  current path (no branch-switcher UI in this rewrite). Root-of-tree
  edits (no parent entry) restart the conversation instead, matching
  chat-v2's "everything after the edited message is discarded" semantics.
- `chat/generationManager.ts` — decoupled streaming/abort/reconnect →
  replaced by a `PiSessionBridge` wrapping pi's own exported `RpcClient` and
  translating its events into the existing SSE contract.
- `chat-v2/validation.ts`, `chat-v2/context.ts` — replaced by pi's own
  session-entry validation and `buildSessionContext`.

Kept as-is, now feeding pi instead of `pi-ai` directly:
- `chat/tools.ts`, `chat/mcp.ts`, `chat/builtins.ts`, `chat/skills.ts` — tool
  resolution logic; only the dispatch target changes (see Tool injection &
  attachment resolution).
- `chat/attachments.ts`, `chat/nativeAttachmentAdapters.ts`,
  `chat/documentTextExtraction.ts` — unchanged, but called at a different
  point: no longer expanded into the message before it's sent/persisted; now
  invoked just-in-time from the `context` extension hook, per conversation,
  never persisted (see Tool injection & attachment resolution).
- `chat/voice.ts`, citations/source handling, presets, folders, tags — all
  Solar-side UI/data concerns untouched.

## Architecture overview

```
browser
  │  typed tRPC + SSE UI Message Stream (unchanged contract)
  ▼
Solar server (Hono/Bun)
  │
  ├── PiSessionManager (new)         — spawns pi's own `RpcClient` ONLY to
  │     spawns RpcClient               generate a new turn, keyed by
  │     for live generation only       conversationId → deterministic
  │                                    `--session-id`/`--session-dir`.
  │
  ├── PiSessionBridge (new)          — translates RpcClient's events
  │     (message_*, tool_execution_*,  into Solar's existing SSE chunk
  │      turn_*, agent_settled,        stream. Not on the hot path for
  │      compaction_*) → SSE            anything except active generation.
  │
  ├── pi-read.ts (new, no process)   — thin wrapper around
  │     SessionManager/parseSessionEntries/buildSessionContext/
  │     ModelRuntime/ModelRegistry, imported directly from
  │     `@earendil-works/pi-coding-agent`. Used for: conversation list/
  │     title/preview, transcript display, search, export, usage rollups,
  │     available-models. No `pi` process involved.
  │
  ├── /internal/pi-bridge/* (new)    — HTTP-only, loopback, per-session
  │     bearer-token-scoped            bearer token. Backs the generic
  │                                    extension's tool + attachment calls
  │                                    (only relevant during live generation).
  │
  ├── chat/tools.ts, mcp.ts, ...     — unchanged: resolves builtin/MCP/skill
  │   chat/attachments.ts               tools and expands attachments;
  │                                    both now invoked via the internal
  │                                    bridge instead of inline.
  │
  └── SQLite — Solar-only facts, nothing pi already owns:
        auth, users, folders, tags, presets, MCP/skill config,
        `conversation` (id, userId, folderId, createdAt — ownership only).

pi --mode rpc (child process, spawned ONLY for live generation)
  │
  ├── pi-bridge/extension.ts (new, single generic file — fetches tool defs
  │     on session_start, registers them; on "context" resolves
  │     `<solar-attachments>` markers just-in-time; never persists either)
  │
  └── SessionManager (pi-owned)       — JSONL tree under
        compaction/branching           SOLAR_PI_AGENT_DIR (see File storage)
```

## Process & session lifecycle

- **Identity: no mapping table.** `conversationId` (Solar's own primary key)
  *is* the pi session identity, by pure convention — no `pi_session` table,
  nothing to keep in sync, nothing that can drift:
  - `--session-id <conversationId>` (pi's own exact, caller-chosen session
    ID mode — creates on first use, resumes thereafter).
  - `--session-dir ${SOLAR_PI_AGENT_DIR}/sessions/<conversationId>`.
  Any code, live process or direct library read, derives both from the one
  ID Solar already has in the `conversation` table for auth/ownership.
- **cwd.** Every conversation gets a stable, empty scratch directory,
  `${SOLAR_DATA_DIR}/pi-cwd/<conversationId>/`, created once and never
  written to by pi (all built-in file/bash tools are disabled — see Tool
  injection & attachment resolution). It exists only because pi requires a
  `cwd` argument; because `--session-dir` is pinned explicitly, the cwd's
  actual filesystem content is irrelevant and can be a zero-byte directory.
- **Spawn policy.** A `pi` process is spawned **only to generate a new
  turn** — sending a message, aborting, changing model/thinking mid-stream.
  Everything else (opening a conversation to read it, listing conversations,
  search, export) is a direct library read against the JSONL file/
  `SOLAR_PI_AGENT_DIR`, no process involved (see Core principle). This
  removes the earlier concern about read traffic driving process count:
  reads don't touch the process pool at all. Pool size
  (`SOLAR_PI_MAX_PROCESSES`, default TBD after load testing) is sized purely
  against concurrently-generating conversations; over the cap, the
  least-recently-used idle process is killed before spawning a new one.
- **Idle reaping.** Kill after `SOLAR_PI_IDLE_TIMEOUT_MS` (default 10 min) of
  no generation activity. Resuming is cheap and correct: re-spawn with the
  same `--session-id`/`--session-dir`, pi reloads the JSONL tree from disk.
- **Crash recovery.** `PiSessionManager` treats an unexpected process exit as
  "idle" — logs it, discards the handle, and re-spawns transparently on the
  next generation request. In-flight generation at crash time is marked
  `interrupted` (mirrors today's restart-recovery story in
  `generationManager.ts`; the `GenerationStatus` value already exists in
  `chat-v2/types.ts`).
- **Watchdog for hung processes.** Two independent, purpose-specific
  timers, both reset by activity (not a flat total-duration cap, so long but
  progressing generations aren't killed):
  - **Startup timeout** (`SOLAR_PI_STARTUP_TIMEOUT_MS`, default 15s): the
    spawned process must emit its first stdout line within this window or
    it's killed and the request fails — distinct failure mode from a
    mid-generation hang (bad binary path, crash before first line).
  - **Stall timeout** (`SOLAR_PI_STALL_TIMEOUT_MS`, default 90s): while a
    generation is in flight, the timer resets on every stdout event
    received; if it lapses, the bridge sends `{type:"abort"}`, waits a
    short grace period for `agent_settled`/`agent_end`, then `kill()`s the
    process if it doesn't respond. The affected turn is marked
    `interrupted` and surfaced to the client the same way an aborted stream
    is today. Re-spawn on the next request is automatic (Crash recovery,
    above).
- **Concurrency.** One process per actively-generating conversation
  serializes all activity on that conversation for free (no separate lock
  table needed, unlike chat-v2's turn/ordinal bookkeeping). Cross-
  conversation concurrency is bounded only by the process pool cap.

## File storage settings (JSONL location)

Two independent, orthogonal knobs, both environment-driven, both defaulting
under Solar's existing `/data` volume (`compose.yaml` already mounts `./data`
for the DB and attachments):

- **`SOLAR_PI_AGENT_DIR`** (maps to pi's `PI_CODING_AGENT_DIR` env var,
  confirmed in `config.js`: `getAgentDir()` reads
  `process.env[PI_CODING_AGENT_DIR]`, falling back to `~/.pi/agent`). Default:
  `/data/pi-agent`. Holds `auth.json`, `models.json`, `models-store.json`,
  and the *default* `extensions/` discovery directory. Solar regenerates
  `auth.json`/`models.json` here from its own DB (see Model catalog) — this
  directory is otherwise pi's, not hand-edited. It's also the root Solar's
  own in-process `ModelRuntime`/`ModelRegistry` reads (see Model catalog),
  and the root under which every conversation's session directory lives.
- **`SOLAR_PI_SESSION_DIR`** — Solar does **not** rely on pi's cwd-hash
  default session directory (`<agentDir>/sessions/--<encoded-cwd>--/`,
  fragile if cwd ever changes) or the `PI_CODING_AGENT_SESSION_DIR` env var
  (global, one value for every spawn). Instead every spawn, and every direct
  library read, uses `${SOLAR_PI_AGENT_DIR}/sessions/<conversationId>`
  explicitly, giving one JSONL directory per conversation, addressed by
  Solar's own ID, independent of cwd (see Process & session lifecycle —
  Identity: no mapping table).
- **Extensions.** The single generic tool-bridge extension is passed
  explicitly via `--extension <path> --no-extensions` on every spawn (as the
  spike does) rather than relying on discovery in `SOLAR_PI_AGENT_DIR`'s
  `extensions/`, so per-conversation spawns can't pick up unrelated
  extensions an operator might drop into that shared directory.
- **Docker/compose.** Add `SOLAR_PI_AGENT_DIR: /data/pi-agent` to
  `compose.yaml`'s `environment:` block; no new volume needed since it's
  already under `/data`.
- **Backup/restore.** `chat-v2/BACKUP_RESTORE.md` today backs up SQLite only.
  After this rewrite, backup must snapshot both SQLite (now small —
  ownership/folders/tags/presets/config only) and
  `${SOLAR_PI_AGENT_DIR}/` in full (session JSONL *and* `models.json`/
  `auth.json`, so a restored deployment doesn't need to be reconfigured).
  Since SQLite holds no conversation content, restoring an older SQLite
  snapshot against newer JSONL (or vice versa) loses at most
  ownership/organization metadata for conversations created in the gap, not
  message history — a much smaller failure mode than today's single-DB
  design.

## Model catalog integration

Today: `chat/catalog.ts` + `provider_config` table (admin-managed, global —
not per-user) drive Solar's own model list and the values passed to
`pi-ai`/`pi-agent-core` directly.

Target: pi becomes the source of truth for "is this model actually usable
right now," while Solar's DB remains the source of truth for "which models
has an admin enabled for this deployment" — and reading pi's answer never
requires spawning a process:

- **Generation.** On boot (and on any admin change to `provider_config`),
  Solar regenerates `${SOLAR_PI_AGENT_DIR}/models.json` from
  `provider_config` rows (provider, baseUrl, api) and `auth.json`
  (apiKey per provider). Pure serialization — same data Solar already holds,
  new target format. `models-store.json` (dynamic provider-refreshed
  catalogs, e.g. OpenRouter) is left to pi to manage; Solar doesn't
  hand-write it.
- **Read path.** Solar constructs a `ModelRuntime` in-process (pointed at
  `SOLAR_PI_AGENT_DIR`, no `pi` binary spawn) and calls
  `new ModelRegistry(runtime).getAvailable()` — both classes are direct,
  documented exports of `@earendil-works/pi-coding-agent`'s main package —
  to get the same `id/name/api/provider/baseUrl/contextWindow/cost/
  reasoning` data the spike observed from the RPC command, synchronously,
  for the new-chat model picker and for rendering any conversation's model
  badge. No short-lived process spawn is needed for this at all (a
  correction from an earlier draft of this plan, which proposed spawning
  one) — it's a library call against the same files a live `pi` process
  would read.
- **Selection.** `set_model` / `set_thinking_level` RPC commands (sent to a
  live `RpcClient` only while a conversation is actually generating) update
  pi's own session state; `provider_config` stays for admin curation only
  (which models are *offered*, not which are *available* — the
  `ModelRegistry` read above is the availability check, e.g. a model with no
  configured auth still shows up in `provider_config` but should not appear,
  or should appear disabled).
- `chat/catalog.ts`'s remote `/v1/models` discovery (`modelsUrl`,
  `fetchProviderModels`) is kept for the admin settings UI (listing what a
  provider *could* offer, before enabling any of it) — that's a
  provisioning-time concern pi has no equivalent for. Only the request-time
  "is this usable" check moves to pi.
- **Decided:** `provider_config` stays permanently global/admin-managed —
  Solar has no per-org or per-user model-credential plans, so a single
  shared `SOLAR_PI_AGENT_DIR/models.json`+`auth.json` for the whole
  deployment is the design, not an interim simplification.

## Tool injection & attachment resolution

The spike's `extension.ts` hardcoded one tool. The real design needs
per-conversation, per-user tool sets (MCP servers, skills) and per-message
attachments, without regenerating or hand-writing an extension file per
conversation, and without ever persisting tool definitions or attachment
bytes into pi's JSONL. This machinery only runs inside a live generation
process — it has no bearing on read paths.

One generic extension, `pi-bridge/extension.ts`, passed on every spawn,
backed by one internal HTTP surface in Solar (`/internal/pi-bridge/*`, see
trust boundary below) doing both jobs:

- **Tools.** On `session_start`, the extension calls
  `GET /internal/pi-bridge/tools?conversationId=...` to fetch the resolved
  tool list (name, description, JSON-schema parameters) — exactly
  `chat/tools.ts`'s existing `CompositeToolProvider.resolve()` output,
  serialized instead of executed in-process. For each tool it calls
  `pi.registerTool({ name, description, parameters, execute })`, where
  `execute` does `POST /internal/pi-bridge/tools/execute` with
  `{ conversationId, toolName, args }` and returns Solar's result. Actual
  execution (MCP client calls, skill reads, `builtins.ts` logic) stays in
  the Solar process unchanged, preserving existing per-user authorization.
  Tool-call latency now includes one extra loopback round trip versus
  today's in-process call (tracked as a residual risk below, not a design
  gap).
- **Attachments.** Solar never inlines attachment bytes into a message sent
  to pi — not at send time, not at import time. Instead, the message text
  Solar submits via the `prompt`/`steer` RPC command carries a small,
  parseable marker for each referenced attachment, e.g. appended to the
  user's text: `<solar-attachments ids="att_123,att_456"/>`. That marker is
  exactly what gets persisted into the JSONL session file — small,
  reference-only, forever. The extension additionally registers
  `pi.on("context", handler)` (fired with the full message list before every
  provider call, able to return a replacement `messages` array per
  `ContextEventResult`). On each call it scans for the marker, and for any
  found, calls `GET /internal/pi-bridge/attachments?ids=...&conversationId=...`
  — which runs the existing `chat/attachments.ts` `expandAttachmentRows`
  server-side, unchanged — and splices the real, model-capability-aware
  content parts into that message for that one outgoing request only. The
  replacement never touches storage: reading the transcript back (whether
  via a live process or the direct-library read path) always sees the
  compact marker, matching how Solar's own `AttachmentRecord`/
  `MessageAttachmentRecord` tables already keep attachments as referenced
  rows rather than inlined blobs. This is a single copy of every attachment
  (Mirage), forever, regardless of how many messages, branches, or edits
  reference it — there is no duplication case to design around.
- **Tool execution progress.** `ToolDefinition.execute` supports a streaming
  `onUpdate` callback (used by pi's TUI for live tool progress). Solar's
  existing `ResolvedTool.execute` (`chat/tools.ts`/`mcp.ts`) is already a
  single-shot promise today — no MCP progress notifications are wired up
  anywhere in the current implementation. So the bridge's `execute` being a
  single blocking `fetch`/await is not a regression; it's parity. `onUpdate`
  is a documented future enhancement point (wiring MCP progress
  notifications through it) that requires no further architecture change
  when someone wants it.
- **Internal endpoint trust boundary.** `/internal/pi-bridge/*` binds to
  loopback only and requires a per-session bearer token generated at spawn
  time, passed via the child's `env`, held only in that process's memory —
  never persisted, never sent to the browser. This is the one new trust
  boundary the rewrite introduces (today everything is in-process function
  calls).
- Builtin coding tools (`read`, `bash`, `edit`, `write`) are disabled on every
  spawn via `--no-builtin-tools` (Solar is a chat/research app, not a coding
  agent — confirmed acceptable in the original assessment); only the
  injected tools plus whatever `--tools` allowlist Solar passes are active.

## Streaming bridge

`PiSessionBridge` wraps pi's own exported `RpcClient` (not a hand-rolled
stdio driver — the spike used one as a stand-in; the real implementation
uses the library's supported client) and re-emits its
events to the same subscriber contract `chat/routes.ts` `GET /stream`
already exposes (`generationManager.subscribe(messageId, lastEventId)`), so
`apps/web`'s assistant-ui integration does not change. Mapping (from the
spike's observed event stream): `message_start/message_update/message_end` →
existing per-part streaming chunks; `tool_execution_start/update/end` →
existing tool call/result chunks; `turn_end`/`agent_end` → turn boundaries;
`agent_settled` → stream completion (matches `RpcClient.waitForIdle()`'s own
terminal signal). Stop/abort maps to the RPC `abort` command instead of
Solar's `AbortController`. **Implementaton notes:** pi's JSON RPC wire strips
`partial` snapshots from `message_update` events, so per-token tool-CALL-arg
streaming is not available at this layer — Solar emits `tool-call-start` +
`tool-call-delta` (full args, once) + `tool-call-end` when pi fires
`tool_execution_start` instead. Titles are written via the live process's
`set_session_name` RPC when it exists (library append when not), so pi's own
`session_info` entry is the canonical title store with no dual write.

## Usage & cost accounting

Today `apps/server/src/context/telemetry.ts`'s `ProviderCallTelemetry`
(persisted to the `provider_call_telemetry` table, migration `025`) records
one row per provider call — tokens, cache tokens, cost, latency, purpose,
retry attempt — written by `generationManager.ts`, aggregated by
`trpc/router.ts`'s admin `usage` query.

Per the Core principle, this data is **fully derivable from JSONL** — every
persisted assistant `SessionMessageEntry.message` already carries its own
`usage` block (confirmed in the spike's raw events), and `CompactionEntry`
carries `usage`/`tokensBefore` for compaction calls. So `provider_call_telemetry`
is retired: the admin `usage` query is served by walking each conversation's
entries via the direct-library read path (`SessionManager`/`get_entries`-
equivalent, no process spawn) and summing `usage` fields, computed on
demand. No live event-tailing writer, no table to keep in sync, nothing that
can silently drift from the one canonical source. Add a persisted rollup
later only if on-demand scanning proves too slow at real data volumes.

## Import of existing chats

One core function, `importConversation(conversationId)`, used two ways: as a
bulk pre-warming tool ahead of cutover, and — because it must be idempotent
and cheap anyway — as the on-demand path that makes a hard cutover moment
unnecessary at all (see Rollout). Built directly against `SessionManager`'s
library API (`SessionManager.create()`, `.appendMessage()`,
`.appendCompaction()`, ...), not hand-formatted NDJSON text — more robust,
and it's the same code path a live process uses to write these files, so
there is no separate "import format" to get subtly wrong.

**Migration status has no DB flag.** Per the Core principle, whether a
conversation has been imported is answered by checking
`${SOLAR_PI_AGENT_DIR}/sessions/<conversationId>/` for a completed session
file, not a new column — consistent with there being no `pi_session` table.
"Completed" specifically: `importConversation` writes to a temporary path
and renames it into place as its last step, so a concurrent reader never
observes a partially-written session file; the existence check that gates
routing (below) only ever sees "not migrated" or "fully migrated," never
"migrating."

**`importConversation(conversationId)`:**

1. If a completed session file already exists for this ID, return
   immediately (idempotent — safe to call unconditionally, safe to re-run
   after a crash partway through a bulk pass).
2. If there is no chat-v2 `conversation` row/canonical messages for this ID
   either, there is nothing to import — this is a brand-new,
   post-rewrite conversation; create an empty session normally instead of
   going through this path at all (the two cases are distinguished by
   whether chat-v2 data exists, not by a flag).
3. Otherwise: `SessionManager.create(cwd, "${SOLAR_PI_AGENT_DIR}/sessions/<conversationId>", { id: conversationId })`,
   then for each `CanonicalMessageRecord` in ordinal order, replace any
   `MessageAttachmentRecord`s with the same `<solar-attachments ids="..."/>`
   marker the live path uses (see Tool injection & attachment resolution) —
   never inline bytes — and call `appendMessage()` (or `appendCompaction()`
   for chat-v2's `origin: "compaction"` messages) in order. There is no
   existing branch data to preserve since chat-v2 has no branching today.
   Write to the temp path, then rename (step above).
4. **Verify before renaming into place**: open the temp session via
   `SessionManager.open()`/`buildSessionContext()` (direct library call, no
   process spawn) and diff the resulting message text against the original
   canonical messages' text content; also confirm every
   `<solar-attachments ids="...">` marker's IDs resolve to a live
   `v2_attachment` row. On mismatch, do not rename into place — leave the
   conversation un-migrated (still served by chat-v2, see Rollout) and log
   the failure for an operator to investigate. One conversation's failure
   never blocks others.
5. **Not preserved, by design:** chat-v2's separate `origin: "voice"` marker
   (folded into a normal message; voice-specific UI already derives its
   affordances from message content, not this field — confirm during
   implementation), and the compaction job queue's history (only the
   *result* of past compactions is replayed as `CompactionEntry` rows, not
   the job bookkeeping).

**Bulk pre-warm script** (`scripts/import-chat-v2-to-pi.ts`) simply calls
`importConversation` for every `conversation` row, with concurrency (each
call is independent library work, no RPC/process involved, so this
parallelizes trivially — e.g. a worker pool of tens of concurrent imports,
not strictly serial). Its purpose is entirely operational head-start
(warm the common case before cutover, get a bulk failure report to fix
ahead of time); it is not what makes migration correct — `importConversation`
being safe to call unconditionally, on-demand, is what does that (see
Rollout). Conversations mid-generation in chat-v2 at the moment the bulk
script visits them are force-stopped first (reuse `chat/routes.ts`
`force-stop` semantics) so there is no in-flight state to lose; the routing
check (Rollout) means this is a non-issue for conversations the bulk script
hasn't reached yet.

This is explicitly a one-time-per-conversation migration, not a dual-write
bridge: once a session file exists for a conversationId, chat-v2's rows for
it are frozen/archival (see Data model changes) and never read again for
that conversation.

## Search & export

Both currently run directly against canonical SQLite rows and have no
substitute once messages move to JSONL — but per the Core principle, neither
needs a new SQLite table by default:

- **Search.** `trpc/router.ts`'s `search` procedure first reads the
  requesting user's own conversationIds from the `conversation` table
  (ownership — genuinely Solar's data), then, for each, opens the session
  file directly via the library read path (`parseSessionEntries`/
  `buildSessionContext`, no process spawn) and filters by text — the same
  shape as today's `rebuildSearchProjection`, just pointed at JSONL instead
  of SQLite rows. No new table. Revisit only if real usage shows per-query
  file scanning is too slow.
- **Export.** `chat-v2/export.ts`'s `CHAT_V2_EXPORT_VERSION` format is
  re-derived from the library read path (entries, not just resolved
  messages, since entries preserve compaction/branch structure the current
  export format already models) per conversation at export time, replacing
  the SQLite-row source with a direct file read. Output shape is unchanged
  from the user's perspective; only the data source changes.

## Data model changes

SQLite's footprint shrinks, not grows, under this rewrite:

- `conversation` keeps only what pi cannot know: `id, userId, folderId,
  createdAt`. Title, last-message preview, and model/provider badges for
  list rendering are read from the session file directly (pi's own
  `SessionInfo`-equivalent data: name, first message, modified time) via the
  library path *for conversations that have a session file* — not stored as
  separate SQLite columns that could drift from pi's session state. For a
  conversation not yet migrated (per-conversation cutover, see Rollout),
  this falls back to reading chat-v2's rows, the same as it does today;
  list rendering during the migration window is a two-way branch on file
  existence, same as generation routing.
- No `pi_session` mapping table (see Process & session lifecycle — Identity:
  no mapping table).
- No `message_search_index` table (see Search & export).
- `provider_call_telemetry` is retired (see Usage & cost accounting).
- `chat-v2`'s tables (`v2_conversation_message`, `v2_context_compaction`,
  `v2_context_compaction_job`, etc.) freeze **per conversation**, not all at
  once: a given conversation's rows stop being written the moment it's
  migrated (chat-v2 never handles a conversation again after that), while
  still-unmigrated conversations keep using chat-v2 normally in the
  meantime. Once every conversation has been touched (Rollout step 4), the
  tables are retained read-only for audit/rollback until a separate future
  cleanup decides to drop them. `v2_attachment`/`v2_message_attachment` stay
  live permanently, not just through that window — they remain the sole
  storage/reference for attachments (see Tool injection & attachment
  resolution); nothing about attachment storage changes shape.

None of the above is permanent: if a specific read path (list rendering,
search, usage reporting) proves too slow against real JSONL at real scale,
add the narrowest possible cache for that one path then — not preemptively.

## Rollout

**Status: completed, in one pass.** The pi engine is now the default (and
only) chat engine; `SOLAR_CHAT_ENGINE=chat-v2` no longer exists as a
fallback — the flag is gone, generation code with it. What survived of
chat-v2 is only the persistence layer that doubles as the import source
(`chat-v2/db/repository.ts`, `types.ts`, `validation.ts`, `context.ts`,
`attachments.ts`, `export.ts`, `import.ts`) — it serves ownership/org tables
and migrates archived conversations into pi sessions on first touch
(`importConversation` runs inline from send/read paths, idempotently).

Per-conversation cutover semantics as designed here still hold exactly:
routing a request asks whether a completed pi session file exists for the
`conversationId`; if not, `importConversation` runs synchronously first
(empty conversations get an empty session). There is no staleness window —
a conversation is either entirely archival (never touched since the cutover)
or entirely on pi with verified full history.

- The bulk pre-warm script (`scripts/import-chat-v2-to-pi.ts`) remains
  available to front-load migration for cold-but-soon-to-be-touched
  conversations.
- The Open WebUI facade was deleted in the same pass (its generation path
  hung off chat-v2); its future shape is archived in
  `docs/planning/openwebui-facade.md`.

## Residual risks (require testing/measurement during implementation, not further design)

Every open design question raised so far has a decision above, including the
DB-footprint concerns this section previously left open. What remains can
only be settled empirically, not on paper:

- **Live-generation process fan-out cost.** One OS process per
  actively-generating conversation is proven correct, not yet proven cheap
  at Solar's real concurrency (spike used one process manually). This is
  now a narrower question than earlier drafts of this plan assumed — reads
  never spawn a process — but still needs load testing before setting
  `SOLAR_PI_MAX_PROCESSES`.
- **Pin/upgrade coupling.** `chat-v2/FREEZE.md` exists because
  `pi-ai`/`pi-agent-core` upgrades broke Solar before. `pi-coding-agent`
  bundles those plus `pi-tui`/`pi-telemetry`/`pi-client`/`pi-protocol` — more
  surface, same org, unclear if the upgrade cadence/breakage risk is better
  or worse. **Decided:** add `@earendil-works/pi-coding-agent` as a real
  `apps/server/package.json` dependency (pinned exact version, like
  `pi-ai`/`pi-agent-core` are today) — both for spawning `RpcClient` and for
  the direct library reads. Upgrades go through the same `bun.lock`-pinned
  review process as any other dependency bump; no separate vendoring
  mechanism. Still needs verifying at implementation time that importing
  the main package for read-only use doesn't pull in TUI/interactive-mode-
  only dependencies at module-load time in a way that bloats server startup.
- **Non-coding chat fit.** pi's default system prompt, tool set, and mental
  model are coding-agent-shaped. `--no-builtin-tools` removes the tools but
  not the framing; whether pi's default system prompt needs
  `--system-prompt`/`--append-system-prompt` overrides for Solar's
  general-chat/research use case is unresolved and should be checked against
  real conversations, not just the spike's single tool-call turn.
- **Internal tool-bridge latency.** Every tool call now costs an extra
  loopback HTTP round trip (extension → Solar → extension) versus today's
  in-process call. Likely negligible but unmeasured.
- **On-demand file-scan performance for search/export/usage.** Reading every
  relevant session file per query (Search & export, Usage & cost accounting,
  conversation list rendering) is simple and correct but its latency at real
  conversation counts/history lengths is unmeasured. If it's too slow, add a
  cache for that specific path then, scoped to what measurement shows is
  actually slow — not speculatively now.
- **Reasoning/thinking retention across process restarts.** Confirmed pi
  retains conversation *content* across restarts (spike's second-request
  test); not yet confirmed that reasoning/thinking blocks and tool-call
  `thoughtSignature` payloads (seen in the spike's raw events) survive a
  process restart mid-conversation without provider-side errors.
- **First-touch import latency.** A long, never-before-migrated conversation
  hitting `importConversation` inline on its first post-cutover message adds
  that conversation's import time to the response latency of one request.
  Expected to be small (library calls, no network/process spawn) but
  unmeasured against real long histories; the bulk pre-warm script exists
  specifically to make this rare in practice, not to be relied on for
  correctness.
