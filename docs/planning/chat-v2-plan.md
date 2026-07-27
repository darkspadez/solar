# Chat V2 Implementation Plan

Status: **Proposed — implementation plan**

Companion to [`chat-history-2.md`](./chat-history-2.md). This is an
outcome-based plan for replacing the current conversation-history implementation
with a linear, destructive, pi-ai-native history store.

This plan intentionally does not include migration work in the core build. V2
should be built and tested against a fresh v2 database and fixtures. The
one-time v1 → v2 migration is a post-completion milestone after the v2 runtime
has been accepted.

There are no dates or time estimates. Each milestone has a demonstrable outcome,
explicit dependencies, and exit criteria.

---

## 1. Scope and locked decisions

### 1.1 In scope

- One linear canonical history per conversation.
- Destructive edit and regenerate.
- One persisted row per canonical pi-ai message.
- Ordered assistant/tool-result continuations.
- Full-fidelity history rendering from persisted pi-ai messages.
- Context construction by replacing exact history ranges with pi-ai-compatible
  compaction messages.
- Asynchronous background compaction.
- Normal text and voice transcript messages through the same history path.
- Durable generation state sufficient to represent partial, stopped, failed, and
  completed attempts.
- Rebuildable display/search projections.
- V2 export/import semantics.
- Tests and operational validation around all data-boundary behavior.

### 1.2 Explicitly deferred

- User-visible branches, alternate responses, or undo history.
- In-run compaction during one agent continuation. The storage design should not
  prevent it, but it is a future generation-loop capability rather than a v2
  history requirement.
- Full durable token-by-token stream replay after process restart, unless the
  implementation requires it for correctness. Batched checkpoints are the
  default.
- Multi-node generation ownership, Redis, and horizontal scaling.
- A provider-independent canonical content-block schema above pi-ai.
- The one-time v1 → v2 migration until all v2 runtime milestones are complete.

### 1.3 Locked storage decisions

1. Persist the pi-ai `Message` payload as canonical message content.
2. Use integer `ordinal` for conversation ordering; timestamps are metadata.
3. Store tool calls and tool results as ordered canonical pi-ai messages.
4. Keep UI turn grouping separate from model message ordering.
5. Keep compactions in a side table; never write summaries into canonical
   conversation history.
6. Edit and regenerate delete a suffix transactionally.
7. Use pi-agent-core's `createCompactionSummaryMessage` and `convertToLlm` for
   synthetic summary messages.
8. Validate parsed JSON at persistence and context boundaries; do not use
   unchecked casts as validation.

---

## 2. Dependency graph

```text
M0 Contracts and fixtures
 └─ M1 V2 schema and persistence boundary
     ├─ M2 Canonical history read/write
     │   ├─ M3 Context materialization and compaction
     │   │   └─ M4 Generation integration
     │   ├─ M5 Destructive edit/regenerate
     │   └─ M6 UI projections and search
     └─ M7 Attachments and voice history
         └─ M8 Export/import and operational hardening
             └─ M9 V2 acceptance and cutover readiness
                 └─ P1 One-time v1 → v2 migration
```

M2, M3, and M4 form the walking skeleton. M5 through M8 add the remaining
conversation behavior without changing the canonical storage contract.

### 2.1 Parallel execution strategy

Parallel work should be organized around stable boundaries rather than broad
milestone ownership. The main work tracks are:

| Track | Primary responsibility |
|---|---|
| Storage | DDL, Kysely types, repositories, transactions, integrity checks |
| Message contracts | pi-ai validation, fixtures, serialization, tool pairing |
| Context | attachment expansion, token policy, compaction, context manifests |
| Generation | lifecycle, checkpoints, finalization, SSE subscription |
| Product surface | UI projections, edit/regenerate actions, search, voice |
| Verification | unit fixtures, integration harnesses, browser flows, operations |

Each parallel work package should own a narrow file/module set and target an
agreed prototype from §4. Schema and shared-type changes are integration gates,
not work that several packages should evolve independently.

#### Milestone 0 parallel work

After agreeing on the pi-ai version and top-level message contract, these can run
in parallel:

- **Message validation:** role-specific runtime schemas and error reporting.
- **Fixture catalog:** text, reasoning, tool, attachment, voice, stopped, failed,
  and compacted sequences.
- **Shared domain types:** statuses, origins, manifests, generation records, and
  compaction records.
- **Observability contract:** structured diagnostic IDs and error/event names.
- **Test harness:** isolated v2 fixture setup independent of the v1 database.

Serial integration gate: validation contracts and fixtures must agree before M1
schema fields or M2 persistence behavior are finalized.

#### Milestone 1 parallel work

Once the planning DDL is locked, these can run in parallel:

- **Schema track:** Kysely migrations, constraints, indexes, and generated types.
- **Repository track:** transaction interfaces and repository behavior against a
  mocked or provisional schema contract.
- **Ownership track:** authorization queries and cross-user rejection tests.
- **Database-test track:** reset helpers, fixture insertion, FK/cascade tests,
  and integrity checks.
- **Attachment-schema track:** asset and binding tables, independent of history
  route integration.

Serial integration gates:

1. The schema migration lands before generated DB types are finalized.
2. Generated types land before repositories are integrated.
3. Repository transaction tests pass before any route switches to v2.

#### Milestone 2 parallel work

After M1 repository contracts are stable, these can run in parallel:

- **Write path:** canonical user/assistant/tool-result append operations.
- **Read path:** ordered canonical history loading and validation.
- **UI projection:** canonical messages to visible user/assistant turns.
- **Tool-loop projection:** grouping assistant/tool-result/continuation messages.
- **Display-text projection:** searchable/renderable text derivation.
- **Walking-skeleton tests:** plain chat and tool-loop fixture integration.

Serial integration gate: the send/generation route should switch only after the
write path, read path, and UI projection agree on one persisted fixture sequence.

#### Milestone 3 parallel work

After canonical history loading works, these can run in parallel:

- **Context materializer:** ordered message loading and immutable projection.
- **Compaction planner:** safe ranges and complete tool-transaction boundaries.
- **Artifact repository:** compaction/job persistence and source-hash checks.
- **Job runner:** queue/run/stale/failed lifecycle independent of request routes.
- **Policy track:** token estimation and selection of retained live history.
- **Manifest track:** exact message, compaction, and attachment decision records.
- **Race-test track:** append-during-job, edit-during-job, overlap, and stale
  completion scenarios.

Serial integration gates:

1. Range substitution and source hashing must be deterministic before the job
   runner can activate artifacts.
2. Artifact selection and manifest output must agree before generation uses the
   compacted context.

#### Milestone 4 parallel work

After generation and context interfaces are fixed, these can run in parallel:

- **Lifecycle repository:** queued/running/terminal state transitions.
- **Checkpoint persistence:** batched partial-message or semantic checkpoints.
- **SSE subscriber:** transport replay and live subscription over the unchanged
  generation interface.
- **Stop/failure behavior:** explicit stopped, failed, and interrupted outcomes.
- **Startup reconciliation:** detection of abandoned running generations.
- **Idempotency tests:** repeated completion/failure callbacks.
- **Disconnect/restart integration tests:** transport and process failure cases.

Serial integration gate: generation finalization must atomically persist canonical
messages and terminal state before the v2 route becomes the default.

#### Milestone 5 parallel work

After suffix-deletion semantics are fixed, these can run in parallel:

- **Repository mutation:** delete suffix by stable turn/ordinal.
- **Edit command:** replacement user turn and generation orchestration.
- **Regenerate command:** replacement assistant generation orchestration.
- **Compaction invalidation:** artifact/job cleanup for intersecting ranges.
- **Asset cleanup:** attachment-reference and file-deletion behavior.
- **Frontend actions:** edit/regenerate requests and optimistic-state removal.
- **Concurrency tests:** stale target, simultaneous edit, edit during generation,
  and regenerate during compaction.

Serial integration gate: edit/regenerate UI should ship only after one repository
transaction owns suffix deletion and all dependent cleanup.

#### Milestone 6 parallel work

The following product-surface slices have limited overlap and can run in
parallel:

- **Attachment lifecycle:** upload, binding, ownership, hash, and cleanup.
- **Attachment context expansion:** model capability and budget decisions.
- **Visible-turn renderer:** text, reasoning, tool calls/results, and failures.
- **Search projection:** text extraction, indexing, and rebuild command.
- **Conversation organization:** list, title, folder, tag, rename, and delete.
- **Projection tests:** canonical history to UI/search outputs.
- **Attachment browser tests:** upload, render, omission, and destructive edit.

Serial integration gate: the attachment context expansion must use the same
context manifest decision vocabulary defined in M3.

#### Milestone 7 parallel work

After synthetic message constructors are agreed, these can run in parallel:

- **Voice message contract:** complete user/assistant transcript constructors.
- **Realtime persistence:** canonical append path and turn grouping.
- **Idempotency:** duplicate completion and late-event suppression.
- **Interruption metadata:** truncation/stop behavior independent of transcript
  content.
- **Voice UI projection:** mixed text/voice rendering.
- **Replay tests:** voice followed by text, model switch, compaction, edit, and
  regenerate.

Serial integration gate: realtime persistence should switch only after synthetic
assistant messages pass the same runtime validator as generated messages.

#### Milestone 8 parallel work

Once the v2 schema is stable, these can run in parallel:

- **Export writer:** canonical history, grouping, metadata, and attachment
  manifest.
- **Import validator/planner:** IDs, ownership, pi-ai messages, and tool pairing.
- **Import transaction:** dependency-ordered relational insertion.
- **Asset transfer:** attachment staging, missing-file behavior, and hashes.
- **Projection round-trip tests:** export/import/rebuild comparisons.
- **Operational diagnostics:** failed generations, stale jobs, integrity checks,
  and structured logs.
- **Backup/restore documentation:** database and attachment-root procedures.

Serial integration gate: import mutation starts only after the complete bundle
has passed validation and the asset plan is known.

#### Milestone 9 parallel work

Acceptance work is intentionally broad and can be split into parallel suites:

- **Server suite:** repositories, context, generation, compaction, and integrity.
- **Frontend suite:** rendering, edit/regenerate, search, attachments, and voice.
- **Browser suite:** representative mock-LLM user flows.
- **Restart suite:** queued/running/stopped/failed/completed recovery.
- **Provider-transform suite:** cross-provider pi-ai replay without live calls.
- **Operations suite:** backup, restore, projection rebuild, and diagnostics.
- **Architecture audit:** confirm no v1 table reads or reconstruction paths remain.

Serial acceptance gate: all suites must pass against the same frozen v2 schema
and message-validation version before migration work begins.

#### Post-completion migration parallel work

After M9 freezes v2, the standalone migration can be split into:

- **Source inspector:** v1 schema/version and relationship inventory.
- **Message translator:** user, assistant, tool-loop, voice, partial, and failure
  conversion rules.
- **Identity/config translator:** users, folders, tags, settings, presets, skills,
  and MCP records.
- **Asset copier:** containment checks, staging, byte counts, and SHA-256.
- **Dry-run planner/reporting:** mappings, warnings, ambiguity, and loss policy.
- **Target writer:** dependency-ordered v2 inserts using a prepared plan.
- **Verification harness:** integrity, counts, tool pairing, context materialization,
  UI reconstruction, and asset checks.
- **Fixture matrix:** clean, ambiguous timestamp, malformed JSON, tool loop,
  voice, attachment, stopped, and failed v1 inputs.

Serial migration gates:

1. Source inspection and dry-run planning complete before any target mutation.
2. Message, identity, and asset plans agree on stable ID mappings.
3. Target publication occurs only after database and asset verification passes.

### 2.2 Parallel execution guardrails

- Do not have multiple work packages independently change shared DDL or message
  contracts. Assign one owner and merge those changes before dependent work.
- Prefer fixture-driven boundaries so repositories, projections, context, and UI
  can progress without sharing unfinished implementation internals.
- Keep routes thin. Parallel packages should integrate through repository and
  service prototypes rather than editing the same route handlers.
- Keep context materialization pure where possible; this allows policy,
  compaction, attachment, and race tests to run independently.
- Keep provider calls mocked. Parallel verification must use `SOLAR_MOCK_LLM=1`
  and must not consume live-model resources.
- Merge each milestone through its serial integration gate before starting work
  that assumes the milestone's runtime behavior is stable.

---

## 3. Target data structures

The following is planning DDL, not a final migration file. Names and exact SQL
types should be adapted to the repository's Kysely conventions.

### 3.1 Conversation and visible-turn grouping

```sql
conversation (
  id text primary key,
  user_id text not null references user(id) on delete cascade,
  title text not null,
  provider text,
  endpoint_id text,
  model_id text,
  model_api text,
  system_prompt text,
  generation_config_json text not null default '{}',
  created_at text not null,
  updated_at text not null
);

conversation_turn (
  id text primary key,
  conversation_id text not null references conversation(id) on delete cascade,
  ordinal integer not null,
  role text not null check (role in ('user', 'assistant')),
  origin text not null,
  status text not null,
  created_at text not null,
  unique (conversation_id, ordinal)
);
```

`conversation_turn` is a UI grouping/projection boundary. It is not the model
history sequence. A visible assistant turn may contain several canonical
messages because of a tool loop.

### 3.2 Canonical pi-ai messages

```sql
conversation_message (
  id text primary key,
  conversation_id text not null references conversation(id) on delete cascade,
  turn_id text references conversation_turn(id) on delete cascade,
  ordinal integer not null,
  role text not null check (role in ('user', 'assistant', 'toolResult')),
  message_json text not null,
  origin text not null,
  status text not null,
  created_at text not null,
  unique (conversation_id, ordinal)
);

create index conversation_message_conversation_ordinal
  on conversation_message (conversation_id, ordinal);

create index conversation_message_turn_ordinal
  on conversation_message (turn_id, ordinal);
```

The `role` column is indexed metadata and must agree with `message_json.role`.
`message_json` is the authoritative content. V2 should use one row per pi-ai
message by default.

### 3.3 Attachments

```sql
attachment (
  id text primary key,
  user_id text not null references user(id) on delete cascade,
  storage_key text not null unique,
  filename text not null,
  mime_type text not null,
  kind text not null,
  byte_size integer not null,
  sha256 text not null,
  width integer,
  height integer,
  page_count integer,
  created_at text not null
);

message_attachment (
  message_id text not null references conversation_message(id) on delete cascade,
  attachment_id text not null references attachment(id) on delete cascade,
  ordinal integer not null,
  primary key (message_id, attachment_id),
  unique (message_id, ordinal)
);
```

Attachment references remain relational metadata. The context materializer
expands them into the pi-ai text/image content required by the selected model.

### 3.4 Generation lifecycle

```sql
generation (
  id text primary key,
  conversation_id text not null references conversation(id) on delete cascade,
  turn_id text references conversation_turn(id) on delete set null,
  status text not null,
  provider text not null,
  api text not null,
  model text not null,
  request_json text not null,
  context_manifest_json text,
  partial_message_json text,
  usage_json text,
  stop_reason text,
  error_message text,
  started_at text,
  finished_at text,
  created_at text not null
);

generation_event (
  generation_id text not null references generation(id) on delete cascade,
  sequence integer not null,
  kind text not null,
  payload_json text not null,
  created_at text not null,
  primary key (generation_id, sequence)
);
```

Generation events are operational/replay data. They are not a second canonical
history representation. Persist batched checkpoints or semantic events only.

### 3.5 Compaction artifacts and jobs

```sql
context_compaction (
  id text primary key,
  conversation_id text not null references conversation(id) on delete cascade,
  first_message_id text not null references conversation_message(id) on delete cascade,
  last_message_id text not null references conversation_message(id) on delete cascade,
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

context_compaction_job (
  id text primary key,
  conversation_id text not null references conversation(id) on delete cascade,
  first_message_id text not null,
  last_message_id text not null,
  source_hash text not null,
  status text not null,
  compaction_id text references context_compaction(id) on delete set null,
  error_message text,
  created_at text not null,
  finished_at text
);
```

Compaction replacement payloads are pi-ai-compatible `Message[]`. A compaction
is valid only for the exact contiguous source range and source hash it records.

### 3.6 Migration and diagnostics metadata

These are only needed if the migration task is implemented after v2. They are
not part of the v2 runtime core:

```sql
migration_issue (
  id text primary key,
  source_kind text not null,
  source_id text,
  severity text not null,
  code text not null,
  detail_json text not null,
  created_at text not null
);
```

---

## 4. Shared contracts and function prototypes

These prototypes define boundaries between milestones. They are planning
contracts, not implementation requirements for exact names.

### 4.1 Message validation

```ts
type CanonicalMessageRecord = {
  id: string;
  conversationId: string;
  turnId: string | null;
  ordinal: number;
  role: "user" | "assistant" | "toolResult";
  message: Message;
  origin: "text" | "voice" | "legacy" | "compaction";
  status: "pending" | "streaming" | "complete" | "stopped" | "error";
};

function parseCanonicalMessage(input: unknown): Message;
function validateMessageSequence(messages: Message[]): void;
function validateToolPairing(messages: Message[]): void;
```

Validation failures should include the conversation ID, message ID, ordinal, and
role-specific reason. They must not be silently converted into empty messages.

### 4.2 History repository

```ts
function listCanonicalMessages(
  conversationId: string,
): Promise<CanonicalMessageRecord[]>;

function appendCanonicalMessages(
  conversationId: string,
  turnId: string,
  messages: Message[],
): Promise<CanonicalMessageRecord[]>;

function deleteConversationSuffix(
  conversationId: string,
  fromTurnId: string,
): Promise<void>;

function createVisibleTurn(
  conversationId: string,
  role: "user" | "assistant",
  origin: "text" | "voice",
): Promise<string>;
```

All mutations must execute inside repository-owned transactions. Routes should
not independently manipulate message and generation tables.

### 4.3 Context materialization

```ts
type ContextManifest = {
  conversationId: string;
  messageIds: string[];
  compactionIds: string[];
  attachmentDecisions: AttachmentDecision[];
  sourceHash: string;
};

function buildOutboundContext(
  conversationId: string,
  selection: ModelSelection,
  policy: ContextPolicy,
): Promise<{
  context: Context;
  manifest: ContextManifest;
}>;

function selectValidCompactions(
  messages: CanonicalMessageRecord[],
  artifacts: ContextCompaction[],
  policy: ContextPolicy,
): ContextCompaction[];

function substituteCompactionRanges(
  messages: Message[],
  ranges: SelectedCompaction[],
): Message[];
```

The materializer should produce a pi-ai `Context` without mutating stored
messages. It should call pi-ai's normal cross-provider transformations only after
range substitution and attachment expansion.

### 4.4 Generation lifecycle

```ts
function startGeneration(input: StartGenerationInput): Promise<Generation>;

function appendGenerationCheckpoint(
  generationId: string,
  checkpoint: GenerationCheckpoint,
): Promise<void>;

function completeGeneration(
  generationId: string,
  messages: Message[],
  usage: Usage,
  stopReason: StopReason,
): Promise<void>;

function stopGeneration(generationId: string): Promise<void>;
function failGeneration(generationId: string, error: Error): Promise<void>;
```

The finalization operation must append canonical messages and terminal generation
state atomically. A client disconnect must not roll back the generation.

### 4.5 Compaction jobs

```ts
function enqueueCompaction(
  conversationId: string,
  range: MessageRange,
): Promise<ContextCompactionJob>;

function runCompactionJob(jobId: string): Promise<void>;

function materializeCompaction(
  jobId: string,
  summaryText: string,
): Promise<ContextCompaction | "stale">;

function invalidateCompactionsIntersecting(
  conversationId: string,
  fromOrdinal: number,
): Promise<void>;
```

`materializeCompaction` must re-check the source hash inside its commit
transaction. A job that finishes against changed history becomes `stale`.

---

## 5. Milestone 0 — Contracts, fixtures, and observability

**Goal:** Freeze the v2 storage contracts and create deterministic fixtures
before changing the live chat path.

**Dependencies:** None.

### Tasks

- Record the installed pi-ai and pi-agent-core versions used by v2.
- Define runtime validation for `UserMessage`, `AssistantMessage`, and
  `ToolResultMessage`.
- Define a complete zero-value `Usage` constructor for synthetic assistant
  messages.
- Define canonical status and origin enums.
- Define message, turn, generation, compaction, and attachment TypeScript types.
- Define how UI visible turns group canonical messages.
- Create fixture builders for:
  - Plain text user/assistant exchange
  - Reasoning assistant message
  - Assistant tool call/result/continuation
  - Image and text attachments
  - Voice transcript pair
  - Stopped and failed generation
  - Compaction replacement range
- Add structured diagnostic fields for conversation ID, turn ID, message ID,
  generation ID, and compaction ID.
- Document which malformed payloads are rejected versus recoverable.

### Exit criteria

- Fixtures serialize and validate through the proposed runtime contracts.
- A fixture sequence containing tool calls/results passes pi-ai transformation.
- Invalid role, usage, timestamp, and tool-pairing fixtures fail with actionable
  errors.
- The v2 test suite can use fixtures without importing v1 persistence code.

---

## 6. Milestone 1 — V2 database foundation

**Goal:** Create a fresh v2 schema and repository layer without changing the
existing production history path.

**Dependencies:** M0.

### Tasks

- Add hand-written v2 migrations for conversation metadata, visible turns,
  canonical messages, generation state/events, attachments/bindings, and
  compaction artifacts/jobs.
- Decide whether v2 uses a separate database filename during development or a
  schema/version selector. Do not add runtime v1/v2 dual reads.
- Add Kysely schema types and regenerate codegen output.
- Add foreign keys and indexes from §3.
- Add repository transactions for append, suffix deletion, and generation
  finalization.
- Add a database-level or repository-level check that `ordinal` is unique per
  conversation.
- Add ownership checks for every conversation, message, turn, generation,
  attachment, and compaction lookup.
- Add a v2 database reset/fixture helper for tests.

### Exit criteria

- A fresh v2 database migrates from empty state successfully.
- Foreign-key and integrity checks pass.
- Repository tests prove append order, suffix deletion, cascade behavior, and
  cross-user access rejection.
- No existing v1 runtime route reads the new tables yet.

---

## 7. Milestone 2 — Canonical history walking skeleton

**Goal:** Replace the basic send/load path with one persisted pi-ai message row
per canonical message.

**Dependencies:** M1.

### Tasks

- Implement canonical message append/load repository functions.
- Persist user messages as complete pi-ai `UserMessage` objects.
- Persist final assistant messages as complete pi-ai `AssistantMessage` objects.
- Persist tool-result messages in their actual sequence.
- Remove the need for `generation_step` reconstruction in the v2 path.
- Build the v2 history-to-`Message[]` loader.
- Build the visible-turn projection for the UI.
- Derive display text from pi-ai content rather than storing a second authoritative
  text field.
- Preserve reasoning in canonical history, with context inclusion controlled by
  policy rather than destructive storage filtering.
- Add model/provider metadata to generation records and retain it in assistant
  payloads as required by pi-ai.
- Keep v1 routes untouched until v2's walking skeleton passes.

### Walking-skeleton flow

```text
authenticated send
  → append user pi-ai message
  → create assistant visible turn
  → start generation
  → stream response
  → append assistant/tool messages
  → finalize generation
  → reload canonical history
  → render visible-turn projection
```

### Exit criteria

- A new v2 conversation supports a multi-turn text exchange.
- Reload reconstructs the exact pi-ai message sequence.
- A tool-loop fixture renders as one visible assistant turn while preserving all
  underlying pi-ai messages.
- A provider request receives the same message sequence that was persisted,
  subject only to pi-ai's provider transformation.
- No `message.text`/`parts` dual-source logic exists in the v2 path.

---

## 8. Milestone 3 — Context materialization and background compaction

**Goal:** Separate full display history from bounded outbound model context.

**Dependencies:** M2.

### Tasks

- Implement deterministic context materialization from canonical messages.
- Implement model policy resolution and token estimation against the v2 sequence.
- Define valid compaction boundaries that do not split tool call/result groups.
- Implement `source_hash` over exact ordered source message payloads.
- Implement compaction artifact selection with non-overlapping ranges.
- Construct summaries through:

  ```ts
  createCompactionSummaryMessage(...)
  convertToLlm(...)
  ```

- Implement range substitution without modifying canonical history.
- Implement asynchronous compaction jobs and stale-source detection.
- Record a context manifest on every generation.
- Invalidate compactions intersecting a destructive suffix edit.
- Preserve valid compactions before an untouched edit boundary.
- Ensure requests use the latest completed compaction without waiting for a
  running background job.
- Add observability for compaction range, source hash, tokens before/after,
  selected artifact IDs, and stale jobs.

### Exit criteria

- The UI displays full canonical history after compaction.
- Outbound context contains replacement summary messages instead of the covered
  source range.
- Tool-call/result groups are never split by a selected compaction.
- Appending messages while a job runs does not invalidate an earlier unchanged
  range.
- Editing a covered range makes the job stale and prevents activation.
- Deleting all compaction artifacts still allows valid full-history generation.
- A generation manifest explains exactly which canonical messages and compactions
  were used.

### Deferred capability

Do not implement in-run compaction in this milestone. Preserve the context
materializer boundary so a future generation loop can replace its working
`Message[]` between safe tool-result boundaries.

---

## 9. Milestone 4 — Generation lifecycle and streaming integration

**Goal:** Make generation persistence and recovery align with canonical message
storage.

**Dependencies:** M2 and M3.

### Tasks

- Move generation creation before provider execution.
- Persist a durable queued/running state before starting the model call.
- Persist batched partial assistant checkpoints during long streams.
- Keep SSE delivery separate from generation persistence.
- Ensure client disconnect does not cancel generation.
- Make explicit Stop produce a valid stopped generation and partial message
  state.
- Make provider errors produce failed generation state without corrupting the
  canonical sequence.
- Finalize canonical messages and terminal generation metadata atomically.
- Add idempotency protection for completion/finalization callbacks.
- Reconcile abandoned `running` generations on startup into an explicit
  interrupted state.
- Keep event sequence monotonic per generation.

### Exit criteria

- Disconnect, reconnect, Stop, provider error, and normal completion each leave
  an inspectable durable state.
- No assistant placeholder is reported as a successful empty response after a
  crash.
- Repeated completion callbacks do not duplicate canonical messages.
- A failed generation does not make later conversation context invalid.
- The SSE layer can be replaced or restarted without changing history semantics.

---

## 10. Milestone 5 — Destructive edit and regenerate

**Goal:** Implement the deliberate linear replacement semantics.

**Dependencies:** M2, M3, and M4.

### Tasks

- Identify target turns/messages by stable IDs.
- Implement one repository command for transactional suffix deletion.
- Abort or mark dependent active generations before deleting their suffix.
- Delete canonical messages, visible-turn groups, generation records, and
  attachment bindings in the correct dependency order.
- Preserve attachment file cleanup as an explicit storage operation.
- Invalidate intersecting compaction artifacts/jobs.
- Implement edit as suffix deletion plus replacement user message plus new
  generation.
- Implement regenerate as suffix deletion plus new assistant generation.
- Reject stale edit/regenerate commands if the target is no longer the selected
  active timeline.
- Ensure suffix deletion uses ordinals/IDs, never timestamps.
- Update conversation `updated_at` and list projections transactionally.

### Exit criteria

- Editing an old user turn removes all later active history and generates a new
  response.
- Regenerating an assistant response removes the old response and later history.
- No alternate branches or hidden old responses are created.
- Attachments associated with deleted messages are removed from both database and
  storage when no longer referenced.
- Active compaction jobs for deleted ranges become stale.
- Concurrent mutation tests allow one valid mutation and reject stale conflicting
  mutations deterministically.

---

## 11. Milestone 6 — Attachments, display projections, and search

**Goal:** Restore the non-generation conversation experience on top of v2
canonical messages.

**Dependencies:** M2 and M5.

### Tasks

- Implement attachment upload and ownership using v2 attachment/binding tables.
- Keep attachment files separate from canonical message JSON.
- Build the context-time attachment expansion layer for text and image models.
- Record explicit attachment decisions in the context manifest:
  - included
  - omitted by budget
  - unsupported by model
  - unavailable
  - summarized
- Build the visible-turn projection for user/assistant rendering.
- Group tool-loop messages correctly in the UI.
- Derive searchable text from canonical pi-ai text blocks.
- Add FTS or the chosen search projection without making it authoritative.
- Rebuild the search projection from canonical messages.
- Restore conversation list, title, folder, tag, delete, and rename behavior.
- Verify folder/tag ownership and cascade semantics against v2 IDs.

### Exit criteria

- Full history renders from canonical messages without a legacy text fallback.
- Attachments display correctly and are supplied only when context policy allows.
- Search results are unchanged after rebuilding the search projection.
- Tool calls/results render as one coherent assistant interaction.
- Conversation organization works without modifying canonical message JSON.

---

## 12. Milestone 7 — Voice history integration

**Goal:** Persist voice transcripts through the same canonical message path as
text chat.

**Dependencies:** M2, M4, and M6.

### Tasks

- Define the v2 voice origin and metadata convention.
- Add shared constructors for synthetic transcript messages:
  - complete `UserMessage`
  - complete `AssistantMessage`
  - zero/estimated `Usage`
  - explicit `stopReason`
- Make realtime user and assistant transcripts append canonical messages.
- Preserve optional audio resources through attachment bindings or voice metadata.
- Add idempotency keys for realtime turn completion callbacks.
- Persist interruption/truncation metadata on the generation or voice record.
- Load voice messages through normal context construction.
- Verify cross-provider replay of plain-text voice assistant messages.
- Ensure voice rows participate in edit, regenerate, compaction, search, and
  export exactly like text rows.

### Exit criteria

- A mixed text/voice conversation reloads through one history loader.
- A voice turn can be followed by a text generation without a special history
  conversion path.
- Duplicate realtime completion events do not create duplicate turns.
- Voice transcripts survive compaction and destructive edit semantics.
- No voice-specific message role is added to pi-ai history.

---

## 13. Milestone 8 — Export, import, and operational hardening

**Goal:** Make v2 history self-contained, inspectable, and safe to operate.

**Dependencies:** M2 through M7.

### Tasks

- Define a versioned v2 export bundle containing:
  - conversation metadata
  - visible-turn grouping
  - canonical pi-ai messages
  - attachments and bindings
  - generation metadata
  - optional compaction artifacts
  - folders, tags, and organization relations
- Validate message roles, content blocks, timestamps, tool pairing, ownership,
  and attachment hashes on import.
- Import relational data transactionally into a target user/conversation.
- Define ID collision behavior: reject by default, explicit remap only when
  requested.
- Treat compactions as optional derived data and verify source hashes when
  imported.
- Add export/import round-trip tests for tool, voice, attachment, and compacted
  conversations.
- Add admin diagnostics for failed generation and stale compaction jobs.
- Add database integrity checks to health/maintenance tooling.
- Add structured logs for history mutations and compaction lifecycle.
- Document backup/restore expectations for the v2 database and asset root.

### Exit criteria

- Export/import round trips preserve canonical message sequences and visible UI
  projections.
- Missing attachment bytes are represented explicitly rather than silently
  dropped.
- Import rejects invalid tool relationships and unauthorized ownership.
- Rebuilding all derived projections produces the same user-facing history.
- Operators can identify and recover failed/stale generation and compaction jobs.

---

## 14. Milestone 9 — V2 acceptance and cutover readiness

**Goal:** Prove the v2 runtime is complete before any v1 migration is attempted.

**Dependencies:** M0 through M8.

### Tasks

- Run the complete server and web typecheck suite.
- Run server and frontend unit tests against isolated v2 databases.
- Run representative browser flows with `SOLAR_MOCK_LLM=1`.
- Verify text, tool, attachment, voice, edit, regenerate, Stop, reconnect, and
  compaction flows.
- Test model switching and cross-provider replay using pi-ai transformations.
- Run database integrity and projection-rebuild checks.
- Test process restart during queued, streaming, stopped, failed, and completed
  generation states.
- Verify no v1 tables or v1 reconstruction paths are read by the v2 runtime.
- Document operational rollback to the preserved v1 installation before
  migration.
- Freeze the v2 schema and message-validation contract for migration work.

### Exit criteria

- All v2 runtime acceptance scenarios pass with mock providers where applicable.
- Full canonical history remains renderable after every context compaction.
- Destructive edit/regenerate behavior is deterministic and tested.
- No known v1 compatibility shim remains in the v2 runtime.
- The target v2 database and attachment format are stable enough for a one-time
  migration.

---

## 15. Post-completion milestone — One-time v1 → v2 migration

**Goal:** Translate an immutable v1 database snapshot into a fresh v2 database
without adding v1 compatibility behavior to Solar.

**Dependencies:** M9 and the migration design in
[`chat-history-2.md`](./chat-history-2.md) §18.

### Tasks

- Build a standalone offline script outside the Solar runtime.
- Accept a read-only v1 SQLite snapshot, attachment root, and fresh v2 output
  paths.
- Add schema-level v1 version checks.
- Add dry-run planning and machine-readable reports.
- Validate ownership, foreign keys, JSON, timestamp collisions, attachment
  existence, byte sizes, and SHA-256 values before mutation.
- Preserve stable IDs where possible and emit source-to-target mappings for
  expanded message rows.
- Order v1 rows deterministically and report ambiguous timestamp ties.
- Convert user rows into pi-ai `UserMessage` payloads.
- Expand v1 generation steps into ordered assistant/tool-result messages.
- Deduplicate v1 terminal tool calls where recoverable.
- Apply explicit synthetic-message rules to voice and text-only assistant rows.
- Reject or report malformed, partial, and irrecoverable payloads without silent
  coercion.
- Do not migrate v1 rolling summary state as active v2 compaction artifacts.
- Stage and hash attachment files before publishing the target asset root.
- Copy selected application metadata in dependency order.
- Apply explicit auth/session/API-key/provider-secret policy.
- Run target database integrity checks and sampled application reconstruction.
- Preserve the v1 source snapshot until v2 acceptance is complete.

### Exit criteria

- Dry-run output is deterministic and identifies all warnings/errors.
- A clean fixture migrates without warnings.
- Mixed text, voice, tool, attachment, stopped, and failed fixtures migrate
  according to the documented rules.
- Timestamp ties and malformed payloads never disappear silently.
- Target database and asset-root verification passes.
- V2 starts and operates without a v1 fallback.

---

## 16. Cross-cutting test matrix

These tests should be distributed across the milestones rather than deferred to
the end.

| Scenario | Required assertion |
|---|---|
| Plain multi-turn chat | Reloaded pi-ai sequence equals persisted sequence |
| Assistant reasoning | Canonical reasoning survives UI reload and policy filtering |
| Tool loop | Tool call/result/continuation order is preserved |
| Context compaction | UI history is unchanged; outbound range is substituted |
| Background compaction race | Append remains valid; intersecting edit makes job stale |
| Concurrent send | One mutation wins; stale mutation is rejected |
| Edit old user turn | Suffix is deleted and replacement generation starts |
| Regenerate assistant | Old response is removed; no branch is created |
| Stop | Partial generation is explicit and reloadable |
| Provider error | Failed generation does not corrupt canonical history |
| Client disconnect | Generation continues and finalizes independently |
| Process restart | Orphaned generation becomes interrupted, not successful-empty |
| Voice sync retry | Duplicate callback does not duplicate messages |
| Attachment omission | Context manifest records the omission reason |
| Search rebuild | Derived search output equals the original projection |
| Export/import | Canonical sequence and UI grouping round-trip |
| Invalid persisted JSON | Boundary validation fails with actionable diagnostics |
| Cross-provider replay | pi-ai handles provider-specific transformations without changing storage |
| v1 migration | Warnings, mappings, and irrecoverable records are reported |

---

## 17. Definition of completion

Chat V2 is complete when:

- The runtime stores and reloads canonical pi-ai messages directly.
- The UI renders complete history from those messages.
- Tool calls, tool results, voice transcripts, and attachments use the same
  history architecture.
- Context compaction is an independently verifiable range substitution.
- Edit and regenerate are destructive linear suffix operations.
- Generation state is explicit and durable enough for supported recovery.
- Derived projections can be deleted and rebuilt.
- The v2 acceptance suite passes without live provider calls.
- The standalone v1 migration can begin as a separate post-completion task.
