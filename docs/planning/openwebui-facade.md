# Open WebUI Compatibility Facade

## Objective

Allow an unmodified Open WebUI client to use Solar as its persistent backend.
The first supported clients are the checked-out releases of Open Relay and
Conduit; the facade should target their shared Open WebUI contract rather than
modify either client.

The initial product requirement is deliberately narrow:

1. Create chats and send/receive basic responses.
2. Enable and disable Solar tools.
3. List, open, and continue existing chats.
4. Delete chats.

The facade is server-side only. It must not become a second canonical chat
implementation.

## Non-goals for the first release

- Forking, patching, or redistributing either client.
- Direct-provider mode.
- Open WebUI channels, knowledge bases, terminal, audio, image generation,
  automations, admin workspace APIs, or other optional features.
- Full branching/version semantics for message trees.
- A generic Open WebUI server implementation independent of Solar.

Unsupported capabilities should be disabled through `/api/config` and omitted
from the facade responses where the clients support capability discovery.

## Current Solar seams

Reuse Solar's existing services directly from the facade; do not call Solar's
own HTTP or tRPC endpoints internally.

- Routing and `Bun.serve`: `apps/server/src/index.ts`
- Authentication/session resolution: `apps/server/src/auth.ts`
- Conversation and message persistence:
  - `apps/server/src/chat-v2/db/repository.ts`
  - `apps/server/src/chat-v2/projection.ts`
  - `apps/server/src/chat/v2Live.ts`
- Chat lifecycle and generation start/stop:
  - `apps/server/src/chat/routes.ts`
  - `apps/server/src/chat/v2Live.ts`
- Generation buffering and cancellation:
  `apps/server/src/chat/generationManager.ts`
- Tool resolution and execution:
  - `apps/server/src/chat/tools.ts`
  - `apps/server/src/chat/mcp.ts`
- Existing domain behavior and authorization can be followed from the
  `conversation`, `model`, `mcp`, `folder`, and `tag` routers in
  `apps/server/src/trpc/router.ts`.

The current generation manager already buffers numbered `UiChunk` values,
retains them briefly after completion, supports subscribers, and owns the
generation `AbortController`. This is the seam for a second transport.

## Target architecture

```text
Open WebUI REST routes       Open WebUI Socket.IO gateway
          │                              │
          └──────── Open WebUI adapter ──┘
                         │
              Solar application services
                         │
       ChatV2 repository / generation manager / tools
```

The facade should be implemented as a focused server module, initially under
`apps/server/src/openwebui/`:

- `routes.ts`: Open WebUI-compatible HTTP routes.
- `adapter.ts`: request, response, ID, history, model, and tool DTO mapping.
- `socket.ts`: Socket.IO/Engine.IO gateway and authenticated task rooms.
- `events.ts`: Solar `UiChunk` to Open WebUI event encoding.
- `types.ts`: facade-only validated DTOs.
- tests colocated with the module.

The exact file split can remain smaller until the contract is proven.

## Current prototype

The server now exposes the initial facade at the shared Open WebUI paths:

- Bearer Solar API keys and facade sign-in, backed by existing Better Auth
  users.
- Configuration, models, chat CRUD/history, folders, task state/stop, and the
  user-scoped Solar MCP server catalog.
- `POST /api/chat/completions`, which starts the existing Solar generation and
  returns the Open WebUI task acknowledgment.
- Socket.IO at `/ws/socket.io/`, using the Bun-native Socket.IO engine. It
  authenticates `auth.token`/`user-join` and maps buffered Solar generation
  chunks to `events` / `chat:completion` messages.

The prototype intentionally keeps Open WebUI pinned/shared/admin configuration,
folder nesting, and unsupported workspace features disabled or unimplemented.

## Generation and Socket.IO design

Do not implement an internal SSE-to-Socket.IO bridge. Add a transport-neutral
subscription seam to `GenerationManager` instead:

1. Extract the current buffered-chunk replay and live-subscriber behavior from
   `subscribe()` into a reusable generation subscription API.
2. Keep the current SSE implementation as one subscriber/encoder.
3. Add Socket.IO as a second subscriber/encoder.
4. Keep `GenerationManager` unaware of Hono, SSE, Socket.IO, rooms, or client
   event names.

The Open WebUI completion flow should be:

1. `POST /api/chat/completions` authenticates the user and parses the Open WebUI
   request.
2. The facade resolves the Open WebUI chat/model/tool identifiers to Solar
   entities.
3. It invokes the existing message/generation services directly.
4. It returns the Open WebUI task acknowledgment using the Solar assistant turn
   ID as the stable task/message ID where possible.
5. The Socket.IO gateway subscribes to that generation and emits the expected
   Open WebUI events.
6. Completion, stop, tool-result, title, and error events are encoded at the
   facade boundary.

The Socket.IO gateway must support authenticated connection, user join, task
subscription, and reconnect replay. Solar's existing in-memory generation
buffer can provide short-lived replay, but the limitation that buffers do not
survive process restart must be explicit.

The verified Open WebUI wire contract uses `/ws/socket.io/`, a Socket.IO
handshake `auth: { token }`, a `user-join` event with the same nested token, and
the `events` envelope `{ chat_id, message_id, data: { type, data } }`. Chat
generation events use `data.type === "chat:completion"`; text deltas use
OpenAI-style `choices[].delta`, and the terminal event sets `data.done`.

Socket.IO is not raw WebSocket. Use an established Bun-compatible
Socket.IO/Engine.IO server library; do not hand-roll the protocol. Validate the
library integration and shared Open WebUI socket behavior before implementing
the rest of the facade.

## REST compatibility surface

Implement only the routes required by the shared Open WebUI contract. The
expected first subset is:

```text
GET    /health
GET    /api/config
POST   /api/v1/auths/signin
GET    /api/v1/auths/

GET    /api/models

POST   /api/chat/completions
GET    /api/tasks/chat/:id
POST   /api/tasks/chat/:id/stop

GET    /api/v1/chats/
GET    /api/v1/chats/:id
POST   /api/v1/chats/new
POST   /api/v1/chats/:id
DELETE /api/v1/chats/:id

/api/v1/folders/*
GET    /api/v1/tools/

The exact tool catalog and toggle routes must be confirmed from both clients
during the contract-test phase rather than guessed from Open WebUI's broader
API.
```

Add the facade routes before the SPA catch-all in `apps/server/src/index.ts` and
register any WebSocket upgrade handling in the same `Bun.serve` lifecycle.

### Authentication

Expose the bearer-token shape expected by the clients at the facade boundary.
Map the authenticated facade principal to the existing Solar user and enforce
user ownership on every conversation, folder, tool, and socket task. Do not
duplicate Better Auth's user database or weaken the existing session checks.

The token format and sign-in response should be decided in the contract phase;
the rest of the facade should depend on a small authenticated-principal
interface rather than Better Auth internals.

### Models and configuration

Map `model.available`/`listAvailableModels()` to Open WebUI model descriptors.
The facade must preserve enough information for the client to select a model,
while translating the selected provider, endpoint, model ID, and API back to
Solar's conversation model fields.

`/api/config` should advertise only the supported subset. In particular, do
not advertise features whose routes are not implemented.

### Conversations and history

Prefer reusing Solar IDs directly:

- Open WebUI chat ID → `v2_conversation.id`.
- Open WebUI folder ID → `v2_folder.id`.
- Open WebUI user → Solar Better Auth user ID.
- Open WebUI task/message ID → Solar assistant turn/message ID.

Use `ChatV2Repository` and `loadMessages()`/`projectVisibleTurns()` to build
Open WebUI chat responses. The first version should expose a single linear
branch:

- `parentId`, `childrenIds`, and `currentId` are synthesized from ordered Solar
  turns.
- Tool-loop records are represented in the assistant message/tool metadata
  expected by the client.
- Client-supplied history is not trusted as the source of truth; the facade
  reconstructs context from Solar's persisted conversation.

Do not add an Open WebUI chat-blob table or compatibility mapping metadata. If
direct Solar ID reuse and synthesized single-branch history are insufficient for
the required workflows, treat the facade experiment as non-viable rather than
introducing a second persistence model.

Conversation operations map to existing repository behavior:

- create → `createConversation`/`startUserTurn` path
- list/open → `listConversations` and canonical message projection
- continue → existing conversation plus Solar context reconstruction
- delete → `deleteConversation` with existing ownership and attachment cleanup
- folder operations → existing folder repository methods

### Tools

The first tool scope is conversation-level enable/disable of Solar MCP-backed
tools. Map the client's selected tool/server identifiers to:

- `mcp.list`
- `mcp.forConversation`
- `mcp.setConversation`
- `mcp.setAutoExecute`

The facade should expose a read-only tool catalog using the same authorization
and discovery rules as `resolveMcpTools()`. Avoid a second MCP discovery path.

At generation time, the existing `toolProvider` must remain the authority for
which tools are actually executable. The facade only changes conversation
configuration and translates the Open WebUI selection into that configuration.

The Socket.IO event encoder must cover the tool-call lifecycle already emitted
by Solar (`tool-call-start`, delta, end, and result). Unsupported Open WebUI
tool types should be hidden rather than advertised.

## Phased implementation plan

### Phase 0 — Shared-contract and runtime spike

- Treat Open Relay and Conduit as consumers of the shared Open WebUI protocol;
  inspect both clients only to capture material differences for the four
  required user stories.
- Turn the captured cases in `docs/planning/openwebui-contract-tests.md` into
  sanitized, executable REST contract fixtures before implementing facade
  routes.
- Socket.IO, tool catalog, folder-write, and stop contracts are source-derived
  and covered by guarded reference tests. Generation replay and tool lifecycle
  still require Solar-side tests.
- Use `socket.io` with `@socket.io/bun-engine`; the Bun-native engine smoke test
  proves the `/ws/socket.io/` path and Socket.IO handshake before facade routes
  are registered.
- Decide whether the facade is enabled by an environment/config flag.
- Define the small common event and DTO contract; reject unsupported optional
  features through configuration.

**Exit criteria:** the sanitized REST contract cases pass against the reference
server, and a stock client can connect to a test Socket.IO endpoint.

### Phase 1 — Facade foundation

- Add the `openwebui` server module and authenticated-principal abstraction.
- Add bearer authentication and user ownership checks.
- Register REST routes and Socket.IO upgrade handling in `index.ts`.
- Implement `/health`, `/api/config`, auth, and `/api/models`.
- Add structured facade logging without logging message contents or tokens.

**Exit criteria:** the stock client completes onboarding, authenticates, loads
configuration, and displays Solar models.

### Phase 2 — Persistent chat CRUD and history

- Implement create, list, open, update/rename, folder assignment, and delete.
- Serialize Solar conversations into the Open WebUI chat DTO/tree shape.
- Support pagination/filter parameters required by the target clients.
- Verify ownership and prevent cross-user ID access.
- Add continuation tests proving a new response uses persisted Solar history.

**Exit criteria:** a chat created on one client session can be listed, reopened,
continued, moved to a folder, and deleted from another session.

### Phase 3 — Direct generation event transport

- Refactor generation subscriptions into a transport-neutral replay/live seam.
- Implement `/api/chat/completions` using existing Solar generation services.
- Implement Socket.IO task rooms and reconnect replay.
- Encode text, reasoning, finish, error, title, stop, and usage events required
  by the target clients.
- Route client stop requests to the existing generation cancellation path.
- Verify that a disconnected client does not cancel generation and can recover
  the final response.

**Exit criteria:** stock-client basic chat streams token-by-token, persists the
  result, handles stop/error, and reconnects within the generation-buffer
  retention window.

### Phase 4 — Tools and folders

- Implement the client-required tool catalog route(s).
- Map tool/server toggles to Solar conversation MCP bindings.
- Map tool lifecycle/results to Open WebUI Socket.IO events.
- Implement folder list/create/rename/delete and chat moves.
- Hide unsupported tool categories and workspace features in `/api/config`.

**Exit criteria:** a user can enable/disable a Solar tool server for a chat,
send a request, observe tool execution, and later reopen the chat with tool
calls/results intact.

### Phase 5 — Client validation and hardening

- Run the same contract suite against unmodified Open Relay and Conduit.
- Test multiple concurrent users and simultaneous generations.
- Test reconnects before first token, during text, during tool execution, after
  completion, and after stop.
- Test deletion while idle and after a completed generation.
- Test process restart behavior and document the in-memory replay limitation.
- Add facade-contract logging and document the tested client behavior.

## Verification strategy

Add tests under `apps/server/src/openwebui/` and run them through:

```bash
SOLAR_MOCK_LLM=1 bun run test:server
```

Required test groups:

- DTO and history projection tests.
- Auth and ownership tests.
- Chat/folder/tool REST route tests.
- Socket.IO handshake, room authorization, event ordering, and replay tests.
- End-to-end mocked generation tests covering text, tools, stop, error, and
  reconnect.
- Manual smoke tests using the unmodified client binaries/source releases.

## Risks and decisions

1. **Socket.IO runtime compatibility:** Bun integration is the first spike and
   could determine the server library or gateway shape.
2. **Client contract drift:** follow the shared Open WebUI protocol and keep
   `/api/config` conservative; record only material client deviations.
3. **History branches:** single-branch projection is acceptable for the MVP;
   branching should not be added until a required client workflow proves it is
   necessary.
4. **Tool granularity:** start with MCP server/conversation toggles. Add
   individual-tool selection only if the stock client requires it for the core
   workflow.
5. **Generation replay:** current buffers are single-node and in-memory. A
   durable event log is outside the first facade release.
6. **Attachments:** exclude file upload/content compatibility initially unless
   the selected client's basic chat flow requires it; advertise the capability
   as disabled otherwise.

## Definition of done

- No client code is changed.
- Open Relay and/or Conduit can authenticate against Solar's facade.
- A stock client can create and stream a chat response.
- The response is persisted in Solar and visible after reconnect/device change.
- Existing chats can be listed, opened, continued, foldered, and deleted.
- Solar MCP tools can be enabled/disabled per conversation and their calls are
  rendered by the client.
- Unsupported Open WebUI features are not exposed.
- Server tests pass with `SOLAR_MOCK_LLM=1`.
