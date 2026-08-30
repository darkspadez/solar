# Open WebUI Facade Handoff

> **Historical handoff document.** The Open WebUI compatibility facade described
> here was removed during the pi RPC migration. Its source paths, branch names,
> test counts, and verification commands are retained as historical context and
> do not describe the current repository.

## Historical state

- Branch: `feat/openwebui-file-uploads`
- Facade commits: `044e344 feat(openwebui): add client compatibility facade`,
  `97a6ab9 feat(openwebui): support image and file uploads`, and
  `d1a7f01 fix(logging): avoid trace stack traces on disconnect`
- This document records the tested continuation point for the next session.

The facade is server-only. Do not modify Open Relay or Conduit.

## What works

Manual Conduit validation completed against local Solar:

1. Sign in and list/open chats.
2. `POST /api/v1/chats/new` creates a Solar conversation.
3. Conduit posts the legacy completion shape using `parent_message`.
4. `POST /api/chat/completions` returns `{ status, task_ids, chat_id }`.
5. Socket.IO emits `start`, text deltas, and a terminal `finish` event.
6. The generated reply persists and renders in Conduit.

The successful Conduit request uses these important fields:

```text
stream: true
model
chat_id
session_id
parent_id
parent_message.content
tool_servers
```

`apps/server/src/openwebui/routes.ts` accepts both the Open WebUI 0.9+
`user_message` shape and Conduit's legacy `parent_message` shape.

Core image/file upload compatibility is now implemented for the reviewed
Conduit and Open Relay clients. The facade accepts multipart `file` uploads at
`/api/v1/files/`, returns both the nested Open WebUI metadata shape and the
flat fields older clients decode, and serves raw bytes from
`/api/v1/files/:id/content`. Conduit's attachment IDs/descriptors and inline
image data URLs, plus Open Relay's current-message `user_message.files`, are
resolved into user-owned Chat V2 attachments. Historical top-level Open Relay
RAG files are deliberately not rebound to follow-up turns.

Reconnect/replay during active generation has been tested and is working:
disconnecting a client does not cancel generation, and a reauthenticated
Socket.IO connection can recover buffered events within the retention window.

Conversation-level MCP enable/disable, auto-execute settings, and tool-call
lifecycle rendering have been tested and are working in Conduit.

The lightweight supporting-state compatibility routes used by the clients,
including pinned-chat state, chat tags, and shared-folder listing, are
implemented as read-only facade responses.

The facade is enabled by default. Unsupported Open WebUI workspace features
are intentionally not exposed or implemented.

Open Relay validation against the same facade is complete and confirmed
working. Its chat lifecycle, uploads, current-turn attachment conventions,
processing status, and ownership behavior work through the facade.

## Main implementation files

- `apps/server/src/openwebui/auth.ts` — Bearer Solar API-key/session resolution
  and facade sign-in.
- `apps/server/src/openwebui/adapter.ts` — Solar model/conversation/history DTO
  translation.
- `apps/server/src/openwebui/routes.ts` — REST compatibility routes.
- `apps/server/src/openwebui/files.ts` — file DTOs, upload/content handling,
  attachment reference resolution, and processing-status compatibility.
- `apps/server/src/openwebui/events.ts` — `UiChunk` to Open WebUI completion
  payload mapping.
- `apps/server/src/openwebui/socket.ts` — authenticated Socket.IO task gateway.
- `apps/server/src/index.ts` — Bun Socket.IO engine wiring and request tracing.
- `apps/server/src/chat/generationManager.ts` — transport-neutral chunk replay
  and live subscription seam.

## Tests and verification

Run server tests with the mock LLM:

```bash
SOLAR_MOCK_LLM=1 bun run test:server
SOLAR_MOCK_LLM=1 bun run typecheck
```

Focused facade tests are colocated under `apps/server/src/openwebui/`:

- `routes.test.ts` includes the observed Conduit legacy task request.
- `files.test.ts` covers multipart upload, MIME normalization, ownership,
  content retrieval, processing status, batch forms, inline images, and
  completion attachment binding.
- `socket.test.ts` asserts `start → text → finish` Socket.IO events.
- `socket-engine.test.ts` validates Bun Engine.IO integration.

The final full server run passes: 209 tests passed, 0 skipped, 0 failed.
The focused upload tests and typecheck also pass.

## Local logs

Foreground server output is mirrored to `.dev-server.log`:

```bash
SOLAR_MOCK_LLM=1 bun run solar dev start --foreground
bun run solar dev logs
```

`SOLAR_SEED_DEV_USER=1` forces trace logging for the managed development
server. Request/body traces redact tokens, cookies, passwords, and message
content, but existing generation trace output includes generated response text;
treat `.dev-server.log` as sensitive local data.

Useful log messages:

```text
facade completion received
facade completion responded
socket task attached
socket completion event emitted
socket task stream ended
```

## Local reference material

- `/tmp/opencode/conduit` is checked out at
  `21ad9d4d330e48d510598536d8459c4a780fd63a`.
- `/tmp/opencode/open-webui` is the local Open WebUI source used to derive the
  reference routes and Socket.IO protocol.

## Remaining work

There is no remaining work for the current facade scope. Open Relay validation,
the full mock-LLM server suite, and typecheck are confirmed.

Full Open WebUI workspace behavior is not deferred work; it is outside the
desired product scope. Do not add arbitrary upload-metadata persistence,
embedding or knowledge-base jobs, binary `/data/content` extraction, archived
chat/notes/settings/profile-image compatibility, or other workspace APIs unless
the product requirements change.
