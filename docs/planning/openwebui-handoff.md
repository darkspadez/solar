# Open WebUI Facade Handoff

## Current state

- Branch: `feat/openwebui-facade`
- Facade commit: `044e344 feat(openwebui): add client compatibility facade`
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

## Main implementation files

- `apps/server/src/openwebui/auth.ts` — Bearer Solar API-key/session resolution
  and facade sign-in.
- `apps/server/src/openwebui/adapter.ts` — Solar model/conversation/history DTO
  translation.
- `apps/server/src/openwebui/routes.ts` — REST compatibility routes.
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
- `socket.test.ts` asserts `start → text → finish` Socket.IO events.
- `socket-engine.test.ts` validates Bun Engine.IO integration.
- `reference-contract.test.ts` runs guarded staging checks when
  `.env.openwebui.local` is loaded.

The last full server run before the facade commit passed: 198 tests passed,
8 skipped, 0 failed. The focused Conduit contract tests and typecheck also
passed after the legacy `parent_message` fix.

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
- `.env.openwebui.local` is gitignored and contains the local staging-reference
  environment. Never print or commit it.

## Remaining work

1. Test reconnect/replay in Conduit while a completion is active.
2. Validate conversation-level MCP enable/disable and tool lifecycle rendering
   in Conduit.
3. Validate Open Relay against the same facade.
4. Consider inert compatibility responses for Conduit’s noncritical probes that
   currently return `404`, including archived chats, notes, user settings, and
   model profile images. They did not block the successful send flow.
5. Decide whether facade sign-in should reuse a managed API key rather than
   creating a Solar API key on every sign-in.
6. Before a PR, rerun the full mock-LLM server suite plus typecheck.
