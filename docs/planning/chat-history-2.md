# Chat History 2

Status: **Proposed — clean-slate design**

This document describes a replacement conversation-history design for Solar. It
deliberately does not address migration, backwards compatibility, or incremental
adoption. The goal is a simple model that preserves the complete history shown
to the user while allowing the model to receive a compacted working context.

The design is based on one central decision:

> Persist the ordered pi-ai message stream directly. Do not invent a second
> canonical message format that must be translated back into pi-ai structures.

The user-facing conversation remains a single destructive linear timeline. Edit
and regenerate remove the affected suffix. There are no user-visible branches,
alternate responses, or history trees.

---

## 1. Goals

- Preserve the exact message history needed to render what the user saw.
- Pass persisted history back to pi-ai with minimal transformation.
- Make tool calls and tool results ordinary ordered pi-ai messages rather than
  opaque side records that must be reconstructed.
- Treat voice turns as ordinary history messages.
- Support context compaction without modifying or hiding canonical history.
- Make edit and regenerate simple, transactional, and deterministic.
- Avoid using timestamps as the source of conversational ordering.
- Keep provider-specific translation inside pi-ai and its provider adapters.

## 2. Non-goals

- Preserving deleted edit/regenerate alternatives.
- Exposing agent-loop branches or tool-loop iterations as conversation branches.
- Building a provider-independent content-block schema above pi-ai.
- Event-sourcing all application state.
- Persisting every streamed token as a database row.
- Solving multi-node generation coordination in this design.

Destructive edit and regenerate behavior is intentional. If a user edits an
earlier turn, the conversation after that turn is replaced rather than retained
as an alternate timeline.

---

## 3. Conceptual model

There are three different representations, each with a narrow responsibility:

```text
Canonical history       Complete ordered pi-ai Message[] in the database
Outbound context        Canonical history with compaction ranges replaced
User interface           A projection/grouping of canonical messages into turns
```

The canonical history is a linear sequence:

```text
user message
assistant message
tool result message
assistant continuation
user message
assistant message
```

The UI may group several model messages into one visible assistant response. For
example, an assistant tool call, its tool result, and the assistant's final
continuation can render as one assistant turn. That grouping is presentation
metadata, not a separate model-history format.

The underlying pi-agent loop may have internal iterations, but those iterations
do not become branches or user-visible turns.

---

## 4. Canonical pi-ai messages

The stored message payload is the complete pi-ai message JSON. Solar should use
the installed pi-ai types at the application boundary rather than persist a
partial approximation.

### 4.1 User messages

```ts
type UserMessage = {
  role: "user";
  content: string | (TextContent | ImageContent)[];
  timestamp: number;
};
```

User content may include text, images, and attachment-derived content. The
database stores the complete object in `message_json`.

### 4.2 Assistant messages

```ts
type AssistantMessage = {
  role: "assistant";
  content: (TextContent | ThinkingContent | ToolCall)[];
  api: Api;
  provider: ProviderId;
  model: string;
  usage: Usage;
  stopReason: StopReason;
  timestamp: number;
  responseModel?: string;
  responseId?: string;
  diagnostics?: AssistantMessageDiagnostic[];
  errorMessage?: string;
};
```

Synthetic assistant messages must still provide the complete structural shape.
For transcript-only messages, usage should be an explicit zero or estimated
usage object, and `stopReason` should normally be `"stop"`. Do not rely on
unchecked casts with incomplete `{}` usage objects.

Provider metadata is retained because it is part of pi-ai's replay contract,
especially for provider-specific reasoning signatures. Plain text messages do
not require provider-specific content, so they remain safe to replay across
models.

### 4.3 Tool results

```ts
type ToolResultMessage = {
  role: "toolResult";
  toolCallId: string;
  toolName: string;
  content: (TextContent | ImageContent)[];
  isError: boolean;
  timestamp: number;
};
```

Tool calls and results are stored in the exact order produced by the agent loop.
The `toolCallId` relationship is part of the canonical payload. A context
compaction range must not split a tool call from its result unless pi-ai's
protocol explicitly permits that shape.

### 4.4 Compaction summaries

Do not persist `role: "compactionSummary"` directly as a pi-ai `Message`; that
role belongs to pi-agent-core's internal message type. Use pi-agent-core's
supported conversion:

```ts
const internal = createCompactionSummaryMessage(
  summaryText,
  tokensBefore,
  timestamp,
);

const replacement = convertToLlm([internal]);
```

The resulting message is a normal pi-ai `user` message containing summary text.
This is the format provider adapters already understand.

---

## 5. Database model

The exact names may change during implementation, but the logical model is:

```sql
conversation (
  id text primary key,
  user_id text not null,
  title text not null,
  created_at text not null,
  updated_at text not null
);

conversation_message (
  id text primary key,
  conversation_id text not null,
  ordinal integer not null,
  visible_turn_id text,
  role text not null,
  message_json text not null,
  origin text not null,
  status text not null,
  created_at text not null,
  unique (conversation_id, ordinal)
);

generation (
  id text primary key,
  conversation_id text not null,
  visible_turn_id text,
  first_message_id text,
  last_message_id text,
  status text not null,
  provider text not null,
  api text not null,
  model text not null,
  request_json text not null,
  partial_message_json text,
  context_manifest_json text,
  usage_json text,
  stop_reason text,
  error_message text,
  started_at text,
  finished_at text
);

generation_event (
  generation_id text not null,
  sequence integer not null,
  kind text not null,
  payload_json text not null,
  created_at text not null,
  primary key (generation_id, sequence)
);

context_compaction (
  id text primary key,
  conversation_id text not null,
  first_message_id text not null,
  last_message_id text not null,
  replacement_messages_json text not null,
  source_hash text not null,
  prompt_version text not null,
  provider text,
  api text,
  model text,
  tokens_before integer,
  tokens_after integer,
  created_at text not null
);
```

`conversation_message.message_json` is authoritative. Columns such as `role`,
`status`, and `ordinal` are indexed relational metadata used for querying and
integrity checks; they must agree with the stored payload where applicable.

`visible_turn_id` is optional grouping metadata for the UI. It does not define
model context ordering and does not replace the ordered message rows.

Attachments remain separate resources, referenced by IDs in the persisted pi-ai
content. Attachment metadata and files are retained while their referenced
message remains in canonical history.

---

## 6. Ordering and identity

Timestamps are metadata only. Ordering is determined by `ordinal`.

Within one conversation:

- `ordinal` is unique and ascending.
- New messages append after the current maximum.
- Destructive edits delete a suffix, so the replacement may reuse the deleted
  ordinal range inside one transaction.
- Message IDs remain stable for the lifetime of a persisted message.
- Generation event `sequence` is unique and ascending per generation.

This removes millisecond-offset workarounds and makes suffix deletion explicit.

The database must not infer order from `created_at`, SQLite's second-resolution
default timestamp, or insertion timing.

---

## 7. Normal send operation

Sending a user message is one logical operation:

1. Begin a transaction.
2. Append a user `UserMessage`.
3. Create a visible assistant turn/group.
4. Create a `generation` in `queued` or `running` state.
5. Commit.
6. Run pi-agent-core using the ordered canonical message history.
7. Persist generated pi-ai messages and terminal generation state.

The user message and assistant placeholder should be durable before the model
request begins. This makes crashes and client disconnects distinguishable from a
message that was never accepted.

## 8. Edit operation

Editing a user message is intentionally destructive:

1. Identify the target message by ID, never by timestamp.
2. Abort any active generation whose messages are in the deleted suffix.
3. Delete all messages at or after the target visible turn.
4. Invalidate compactions intersecting the deleted range.
5. Insert the replacement user `UserMessage`.
6. Start a new assistant generation.

All steps that mutate history occur in one transaction where possible. The
original message IDs are not retained in the active conversation because the
product does not expose undo or alternate branches.

## 9. Regenerate operation

Regenerating an assistant response:

1. Identify the assistant visible turn by ID.
2. Abort its active generation if necessary.
3. Delete that assistant turn and all later messages.
4. Invalidate intersecting compactions.
5. Insert a new assistant generation at the same logical position.

The previous response is not preserved as a branch or alternate answer.

## 10. Generation lifecycle

Generation state is operational state, not message content.

```text
queued → running → complete
                 ├→ stopped
                 ├→ failed
                 └→ interrupted
```

The generation may produce several canonical pi-ai messages because a tool loop
can contain assistant/tool-result/assistant sequences. The UI groups them under
one visible assistant turn.

For streaming, the server may retain an in-memory SSE buffer for immediate
delivery, but the durable state should include at least:

- Generation status
- Partial assistant message or checkpoint
- Provider/model request identity
- Usage and stop reason
- Error state

If durable reconnect after process restart becomes necessary, persist batched
`generation_event` rows or periodic pi-ai message checkpoints. Do not introduce
a second canonical content format merely to represent token deltas.

---

## 11. Context compaction

Compaction never changes canonical history. It creates a derived replacement for
an exact contiguous message range.

Example canonical history:

```text
M1 system configuration
M2 user
M3 assistant tool call
M4 tool result
M5 assistant continuation
M6 user
M7 assistant
```

Compaction record:

```text
first_message_id: M2
last_message_id:  M5
replacement:      [S1]
```

Display history remains:

```text
M1, M2, M3, M4, M5, M6, M7
```

Outbound context becomes:

```text
M1, S1, M6, M7
```

### 11.1 Compaction validity

Each compaction stores a `source_hash` over the ordered source message IDs and
serialized payloads. It is valid only when:

- The conversation is the same.
- Every source message still exists.
- The source message sequence and payloads still match the hash.
- The replacement range is contiguous.
- The replacement does not violate pi-ai tool-message ordering.

Destructive edits remove or invalidate any compaction whose range intersects the
deleted suffix. Compactions entirely before the edit remain usable.

### 11.2 Multiple compactions

Non-overlapping compactions may be selected together:

```text
M1..M10   → S1
M11..M20  → S2
M21..M30  → S3
M31..M33  → live history
```

The context builder must reject overlapping or ambiguous replacement ranges.
A newer compaction can supersede an older one by covering a larger range, but
the canonical messages are never deleted.

### 11.3 Context construction algorithm

The outbound context builder:

1. Loads the complete ordered canonical message list.
2. Chooses valid, non-overlapping compactions according to context policy.
3. Walks the message list in ordinal order.
4. Emits a compaction's replacement messages at its first source message.
5. Skips through that compaction's last source message.
6. Emits all other canonical messages unchanged.
7. Applies pi-ai's normal cross-model transformation at the provider boundary.
8. Stores a context manifest on the generation.

The context manifest should record the history revision, selected compaction IDs,
and live message IDs. This makes it possible to explain exactly what the model
saw without duplicating the complete request payload.

### 11.4 Compaction replacement format

Replacement payloads must be pi-ai-compatible `Message[]`. For summaries, use
pi-agent-core's supported helper rather than hand-creating an unsupported role:

```ts
const internal = createCompactionSummaryMessage(
  summaryText,
  tokensBefore,
  new Date().toISOString(),
);

const replacementMessages = convertToLlm([internal]);
```

The converted output is an ordinary pi-ai user message. Provider adapters do not
need to know that it represents a compaction.

A replacement may contain multiple messages when needed to preserve tool state
or other protocol requirements.

### 11.5 Asynchronous compaction

Compaction is an asynchronous cache-building operation. It must never block a
normal request unnecessarily and must never mutate canonical history.

The lifecycle is:

1. Select a contiguous source range, such as `M2..M20`.
2. Read the source messages and calculate their `source_hash`.
3. Create a queued compaction job.
4. Generate the replacement summary outside the conversation write
   transaction.
5. Re-check the source range and hash when generation completes.
6. Insert the immutable `context_compaction` artifact only if the source still
   matches.
7. Mark the job complete, stale, or failed.

The job may be tracked separately from the finished artifact:

```sql
context_compaction_job (
  id text primary key,
  conversation_id text not null,
  first_message_id text not null,
  last_message_id text not null,
  source_hash text not null,
  status text not null,       -- queued | running | complete | stale | failed
  compaction_id text,
  error_message text,
  created_at text not null,
  finished_at text
);
```

#### Concurrent appends

If a job covers `M2..M20` and new messages arrive while it runs, the result
remains valid:

```text
M2..M20 → S1
M21     → live history
```

The next outbound request can use `S1` followed by `M21` and any later messages.
New messages do not invalidate a compaction covering an earlier unchanged
prefix.

#### Edits during compaction

If an edit affects any message inside or after the compaction range, the
destructive suffix operation removes or invalidates the affected artifact. A
job that finishes after the edit fails its source-hash check and is marked
`stale`; it must not be activated.

If an edit occurs entirely after the covered range, the compaction remains valid
because its source messages and payloads are unchanged.

#### Requests while compaction is running

Context assembly uses the latest completed, valid compaction. It does not wait
for a newly queued or running compaction unless a future policy explicitly
requires that behavior:

```text
latest completed compactions + uncompressed recent messages
```

This keeps background compaction from adding latency to ordinary generation.

#### Multiple jobs and stale results

Compaction jobs may finish out of order. An artifact is usable only when its
source range is still present, its hash matches, and it does not overlap another
selected artifact. A newer artifact may supersede an older one by covering a
larger range; neither case changes canonical history.

This yields a simple separation:

```text
Canonical history = truth
Compaction        = optional derived cache
Outbound context  = deterministic projection
```

Deleting every compaction artifact must still leave the conversation fully
usable; the context builder can fall back to the complete message history and
trigger another asynchronous compaction when appropriate.

### 11.6 Future consideration: in-run compaction

The same range-replacement mechanism could support compaction during a single
agent generation. This is not required for the chat-history rework, but it is a
useful consequence of keeping canonical history separate from outbound context.

Tool-heavy runs can perform many assistant/tool-result continuations before a
normal user turn ends. Waiting for the next user message may allow the active
context to become unnecessarily large. A future generation manager could
compact the working context between model requests:

```text
assistant tool call
tool result
assistant tool call
tool result
    → compact an old safe range
assistant continuation with reduced context
```

An in-run compaction would be scoped to the generation or run checkpoint rather
than inserted into canonical conversation history:

```text
canonical history: M1..M47, M48, M49
active run context: M1, S2, M48, M49
```

The full messages remain available for user-facing history. The replacement
summary is only an internal context optimization, optionally persisted as a
generation checkpoint for restart recovery.

The safe boundary must preserve complete pi-ai protocol groups. In particular,
the system must not compact between an assistant tool call and its tool result.
The natural trigger point is after a tool result and before the next assistant
continuation, when the context estimate approaches the model policy threshold.

Whether this is practical depends on the continuation hooks exposed by
`pi-agent-core`. If it cannot replace the active `Message[]` between iterations,
Solar may need to own more of the continuation loop or restart it from a
compacted context while retaining one logical generation. That implementation
question is deferred and does not constrain the storage design.

---

## 12. Speech history

Speech transcripts are persisted as ordinary canonical pi-ai messages with
`origin = "voice"`.

```ts
const userMessage: UserMessage = {
  role: "user",
  content: [{ type: "text", text: userTranscript }],
  timestamp,
};

const assistantMessage: AssistantMessage = {
  role: "assistant",
  content: [{ type: "text", text: assistantTranscript }],
  api,
  provider,
  model,
  usage: zeroUsage(),
  stopReason: "stop",
  timestamp: timestamp + 1,
};
```

Audio recordings, if retained, are attachment references or side metadata. The
transcript remains the model-replay content.

Realtime interruptions should be represented in generation/voice metadata, not
by attempting to synthesize a special conversational role. Duplicate realtime
completion callbacks require an idempotency key so they cannot insert duplicate
user/assistant pairs.

The next text generation loads these voice messages through the same history
loader as text-generated messages.

---

## 13. Provider boundaries

Solar should not translate canonical history into a custom Solar block format.
The only transformations should be:

```text
Persisted pi-ai Message[]
  → compaction range substitution
  → pi-ai transformMessages/provider adapter
  → provider request
```

Pi-ai already handles cross-provider concerns such as unsupported images,
reasoning signatures, and tool-call ID normalization.

Solar must still validate persisted JSON at real boundaries. Type assertions after
`JSON.parse` are insufficient. At minimum, validate:

- Valid message role
- Required role-specific fields
- Valid content-block discriminants
- Assistant metadata and complete usage shape
- Tool-call/result ID relationships
- Numeric timestamps

Provider-native diagnostic payloads may be retained separately, but they are not
required to reconstruct canonical history.

---

## 14. UI and search projections

The UI should consume a projection rather than understand every pi-ai message
type directly.

The projection groups canonical messages into visible turns:

```text
user message                         → user turn
assistant + tool result + assistant  → assistant turn
```

Search text is derived from text-bearing pi-ai content blocks. It must be
rebuildable from `message_json`; it is never independently edited as a second
source of truth.

Reasoning can be hidden from ordinary model context according to policy while
remaining present in canonical history for display or audit.

---

## 15. Import and export

An export contains:

- Conversation metadata
- Ordered canonical pi-ai messages
- UI grouping metadata
- Attachments and references
- Generation metadata
- Context compaction artifacts, optionally

Import validates message payloads, ordering, tool relationships, and ownership
before inserting the conversation transactionally.

Compactions may be omitted during export because they are rebuildable derived
artifacts. If included, their source hashes must be checked against the imported
message sequence.

---

## 16. Invariants

1. `message_json` is the authoritative message content.
2. Message order is ordinal, never timestamp-based.
3. Canonical history is linear and destructive.
4. Tool calls and results remain ordered pi-ai messages.
5. Compactions never mutate canonical history.
6. A compaction references an exact contiguous source range.
7. A compaction replacement is a valid pi-ai `Message[]`.
8. A context request records which compactions and messages it used.
9. UI text and search text are derived projections.
10. Provider-specific transformations happen only at the pi-ai boundary.
11. Synthetic assistant messages have complete pi-ai metadata.
12. Voice messages use the ordinary canonical message path.
13. Edit and regenerate operations are transactional suffix replacement.

---

## 17. Open implementation questions

These do not change the core design but should be resolved during implementation:

- Whether canonical rows represent every pi-ai message or whether a visible
  turn row owns a JSON array of pi-ai messages.
- Whether streamed checkpoints are sufficient or durable generation events are
  required for restart-time replay.
- Whether voice audio is retained or only transcripts are persisted.
- The exact synthetic metadata convention for assistant messages produced by the
  realtime API.
- Whether compaction artifacts are retained across export/import or regenerated.
- Whether pi-ai message validation uses a maintained runtime schema or a small
  role/content validator.

The preferred default is one row per pi-ai message because it gives simple
ordering, tool-result pairing, range compaction boundaries, and direct replay.

---

## 18. Post-completion task: one-time v1 → v2 migration

After the v2 history implementation is complete and accepted, build a dedicated
offline migration tool. This is a one-time translation from a v1 database and
attachment directory into a new v2 database. It is not part of Solar's runtime,
does not run at server startup, and does not add a v1 compatibility path to v2.

Suggested shape:

```text
scripts/migrate-history-v1-to-v2.ts
```

The exact filename is not important. The important boundary is that the tool
imports v1 source code/types as migration dependencies and is never imported by
the production server.

### 18.1 Input and output

Inputs:

- A read-only v1 SQLite database snapshot.
- The matching v1 attachment storage directory.
- A target directory for staged attachment files.
- An explicit migration configuration or user-mapping manifest when needed.

Outputs:

- A newly created v2 SQLite database.
- A newly created v2 attachment root.
- A machine-readable migration report.
- A mapping/audit file containing source IDs, target IDs, warnings, and rejected
  records.

The source database must not be migrated in place. Before running the tool, stop
the v1 server and take a consistent SQLite snapshot, including the `-wal` and
`-shm` state as appropriate. Keep the source database and attachment snapshot
unchanged until v2 acceptance is complete.

### 18.2 Identity and secrets

The migration must make identity policy explicit rather than accidentally
copying authentication state.

Recommended default:

- Preserve v1 user IDs where the v2 auth schema is compatible.
- Copy user records needed for login identity.
- Copy account identity records only when Better Auth versions and schemas are
  explicitly compatible.
- Do not copy sessions, verification records, or API keys by default; users must
  sign in again and API keys must be reissued.
- Do not copy provider API keys or other provider secrets by default.

If v2 deliberately uses a different identity scheme, accept an explicit
source-user-to-target-user mapping manifest. Reject duplicate or ambiguous email
matches. Never infer ownership from conversation data alone.

This migration is primarily for application history. Authentication and secrets
are separate migration decisions and must not be copied as an incidental side
effect of copying conversations.

### 18.3 Migration phases

The tool should have distinct phases:

1. **Inspect** the source schema and verify the expected v1 migration level.
2. **Validate** ownership, foreign keys, JSON, ordering, and attachment files.
3. **Plan** source-to-target IDs and message expansion without mutating output.
4. **Dry-run report** counts, warnings, errors, ambiguous records, and estimated
   output.
5. **Stage assets** and verify their hashes.
6. **Create and populate** the v2 database in dependency order.
7. **Verify** database integrity, relationships, assets, and representative
   reconstructed conversations.
8. **Publish** the target database and attachment root only after all checks pass.

The default execution should abort on validation errors. Any lossy recovery mode
must be an explicit flag and must be recorded in the migration report.

### 18.4 Preserving IDs and mappings

Preserve existing IDs for entities that remain conceptually equivalent:

- Users
- Conversations
- Folders
- Tags
- Presets
- Skills
- MCP servers
- Attachments

The v1 `message` row represents a visible turn, while v2 may create several
canonical pi-ai messages from one v1 row. Therefore:

- Preserve the v1 message ID as `visible_turn_id` or migration metadata.
- Allocate new v2 `conversation_message.id` values for each expanded pi-ai
  message.
- Record every source-message-to-target-message mapping.
- Assign v2 `ordinal` values only after the complete expanded sequence is known.

Do not derive v2 ordinals from timestamps.

### 18.5 v1 ordering

V1 has no authoritative conversation sequence. Its normal read path orders by
`createdAt`, and equal timestamps are possible because SQLite defaults have only
second resolution.

The migration should order source rows by:

```text
(createdAt binary ascending, source message ID binary ascending)
```

The source ID tie-breaker makes the migration deterministic, but it cannot prove
the original intended order. The report must list every timestamp collision.

Recommended behavior:

- Default strict mode aborts when a timestamp collision can affect message
  ordering or destructive-suffix interpretation.
- An explicit `--allow-ambiguous-order` mode uses the deterministic ID
  tie-breaker and records the affected conversations.

### 18.6 Message conversion

#### User rows

For each v1 user row, emit one v2 pi-ai `UserMessage`:

- Use the v1 text and valid skill-invocation metadata according to the existing
  v1 contextual-text behavior.
- Use the v1 timestamp when it parses as a finite millisecond timestamp.
- Attach the migrated attachment bindings to the corresponding v2 visible turn.
- Keep attachment resources separate from `message_json`; the v2 context
  materializer expands supported attachments into pi-ai text/image content at
  request time.
- Mark voice-origin rows with `origin = "voice"` when the migration can identify
  them from the v1 voice-sync relationship/metadata. Otherwise use
  `origin = "legacy"` rather than guessing.

#### Assistant rows without tool steps

If `message.parts` parses as a complete valid pi-ai `AssistantMessage`, emit it
after removing Solar-only UI metadata such as `solarToolCalls`. Preserve its
native content and provider metadata.

If the row is a text-only voice response with no pi payload, construct a complete
synthetic assistant message with text content, zero or explicitly estimated
usage, `stopReason: "stop"`, a numeric timestamp, and the documented voice
origin.

Other text-only assistant rows without valid pi metadata require an explicit
legacy synthetic-message convention. The migration must not silently create
incomplete assistant objects with `{}` usage or unchecked `unknown` fields.

#### Assistant rows with generation steps

V1 stores intermediate assistant and tool-result messages in
`generation_step.data`, while the terminal `message.parts` may contain duplicated
tool calls and aggregated content. Convert in this order:

1. Load steps by `(messageId, sequence)`.
2. Parse and validate each step independently.
3. Emit valid assistant and tool-result messages in sequence order.
4. Parse the terminal `message.parts` candidate.
5. Remove Solar-only metadata.
6. Remove terminal tool calls whose IDs were already emitted from valid steps.
7. Emit remaining terminal text/thinking as a final assistant continuation when
   it represents content not already emitted.
8. If v1 has tool steps but no recoverable terminal text structure, use
   `message.text` for one explicit legacy-recovered final assistant message when
   it is non-empty.

The migration must not use `solarToolCalls` as a replacement for a missing,
invalid tool-result message unless the result is actually recoverable. A missing
tool result should be reported rather than fabricated.

V1 streamed reasoning may have been aggregated into a terminal payload without
its original position. Preserve valid reasoning only when its placement is
unambiguous; otherwise record the ambiguity in the migration report.

#### Partial and failed rows

V1 rows with `generating` or `error` status must not be blindly emitted as valid
completed model messages.

- Create a v2 generation record with `interrupted` or `failed` status.
- Preserve valid partial pi JSON in `partial_message_json` when available.
- Emit a canonical assistant message only when it passes v2 validation or can be
  recovered using an explicit synthetic-message rule.
- Preserve unrecoverable v1 display/error text in migration diagnostics rather
  than inventing a provider payload.

The migration report must identify every conversation containing partial,
failed, malformed, or recovered data.

### 18.7 Compaction state

Do not convert v1 `conversation_context_state.summary` directly into a v2
`context_compaction` artifact. V1 does not retain the exact source message range,
source hash, or pi-ai replacement message needed by v2.

Instead:

- Migrate the canonical v1 messages.
- Omit v1 rolling summaries from active v2 context state.
- Regenerate v2 compactions after migration using v2 message ordinals.
- Preserve the old summary only in the migration report or an explicitly
  diagnostic legacy table if operational investigation requires it.

This prevents a plausible-looking but unverifiable summary from being treated as
valid context.

### 18.8 Attachments and files

SQLite foreign keys cannot atomically move attachment files. Treat assets as a
separate staging domain:

1. Validate each referenced v1 attachment row.
2. Validate that its storage key resolves inside the configured v1 attachment
   root; reject path traversal or missing files.
3. Copy to a staging v2 asset root.
4. Verify byte size and SHA-256.
5. Insert v2 attachment metadata and message bindings in the target transaction.
6. Publish the staged asset root only after the database transaction and all
   verification checks succeed.

Unreferenced v1 attachment rows should be reported and omitted unless a future
   explicit orphan-preservation option is added. The migration must never delete
   source files.

### 18.9 Other v1 records

Copy relational application data in dependency order:

```text
users/auth identity policy
→ folders, tags, presets, settings, skills, MCP servers
→ conversations
→ canonical conversation messages
→ attachments and bindings
→ conversation tags and MCP assignments
```

Provider-call telemetry and v1 token aggregates are operational metadata. Copy
them only where v2 has a compatible destination; they are not required to
reconstruct history.

The v1 mutable context-state job fields, old compaction summary, and in-memory
generation buffers are not canonical data and are not migrated into active v2
state.

### 18.10 Atomicity and verification

The target database should be populated in one transaction per migration run,
with `PRAGMA foreign_keys = ON`. The tool must never disable foreign-key checks
to force an import.

Before publishing the result, run:

- `PRAGMA integrity_check`
- `PRAGMA foreign_key_check`
- Per-table and per-user source/target count comparisons
- Conversation/message/attachment relationship checks
- Canonical pi-ai message validation
- Tool-call/result pairing validation
- Attachment byte-size and SHA-256 verification
- Sampled UI-history reconstruction
- Sampled outbound-context construction without a provider call

The report must include source database identity, v1 migration level, target
identity, tool version, options, counts, warnings, recoveries, and failures.

The original v1 database and attachment snapshot remain the rollback source. The
tool does not modify or clean up either source.

### 18.11 Migration acceptance criteria

The post-completion task is complete only when:

- A dry run produces a deterministic plan without creating target state.
- A clean v1 fixture migrates with no warnings.
- Voice-only and mixed voice/text conversations replay through the normal v2
  history loader.
- Tool-loop conversations preserve valid assistant/tool-result ordering.
- Compaction state is intentionally regenerated rather than silently reused.
- Timestamp collisions are reported and strict-mode behavior is tested.
- Malformed and partial legacy records are rejected or explicitly reported, never
  silently coerced.
- Attachment files and database references are verified together.
- Re-running against the same source produces the same target or refuses to
  overwrite it without an explicit output replacement action.
- V2 starts against the migrated database without any v1 runtime fallback.
