# Chat V2 Archive and Migration Layer

The active chat engine is `apps/server/src/pi/`, backed by
`@earendil-works/pi-coding-agent`. Pi session JSONL is the canonical source for
conversation messages.

The surviving `chat-v2` modules are the legacy archive and migration layer. They
read and write the frozen SQLite representation used by imports, exports,
attachments, and Solar-owned conversation metadata; they are not the live
generation engine or canonical message store.

## Legacy storage contract

The legacy v2 representation uses `v2_`-namespaced tables in the existing SQLite
database. This retains
the existing Better Auth `user` table for ownership foreign keys while keeping
the clean-slate schema distinct from v1 tables. The v2 repository is isolated
under `chat-v2/db`; current routes use it for ownership, attachments, settings,
and migration/export fallback, not for live message generation.

Legacy canonical persistence rejects unknown roles, invalid content discriminants,
non-finite timestamps, incomplete assistant metadata or usage, and unmatched,
duplicated, or misnamed tool results. These payloads cannot be stored as
archived v2 messages. A missing tool result is not recoverable at this boundary,
even though pi-ai's provider transformation can synthesize one for an outbound
request.

Recovery occurs before this boundary and must be explicit: a legacy or voice
text-only assistant response may become a synthetic complete assistant message
with `zeroUsage()` and `stopReason: "stop"`; a compaction summary must be created
through `createCompactionSummaryMessage` and `convertToLlm`. Invalid historical
payloads that cannot be reconstructed this way remain diagnostic failures rather
than empty canonical messages.
