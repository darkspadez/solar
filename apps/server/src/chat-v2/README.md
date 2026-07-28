# Chat V2 M0 contracts

This module targets `@earendil-works/pi-ai` and `@earendil-works/pi-agent-core`
version `0.80.10`. It defines no database access, routes, or v1 imports.

## M1 storage decision

V2 uses `v2_`-namespaced tables in the existing SQLite database. This retains
the existing Better Auth `user` table for ownership foreign keys while keeping
the clean-slate schema distinct from v1 tables. The v2 repository is isolated
under `chat-v2/db`; no v1 route reads or writes these tables.

Canonical persistence rejects unknown roles, invalid content discriminants,
non-finite timestamps, incomplete assistant metadata or usage, and unmatched,
duplicated, or misnamed tool results. These payloads cannot be stored as
canonical v2 messages. A missing tool result is not recoverable at this boundary,
even though pi-ai's provider transformation can synthesize one for an outbound
request.

Recovery occurs before this boundary and must be explicit: a legacy or voice
text-only assistant response may become a synthetic complete assistant message
with `zeroUsage()` and `stopReason: "stop"`; a compaction summary must be created
through `createCompactionSummaryMessage` and `convertToLlm`. Invalid historical
payloads that cannot be reconstructed this way remain diagnostic failures rather
than empty canonical messages.
