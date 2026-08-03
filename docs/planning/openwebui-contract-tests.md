# Open WebUI REST Contract Cases

These cases are derived from the official Open WebUI UI captures:

- `new_chat_request.har`
- `load_old_chat.har`
- `delete_chat.har`

The raw captures remain outside the repository. They contain credentials and
personal data; only sanitized protocol expectations belong in tests.

## Test harness rules

- Run each case against the reference Open WebUI server and the Solar facade.
- Inject a test bearer token at runtime. Never store `Authorization`, `Cookie`,
  session, or API-key values in fixtures.
- Replace captured hostnames, UUIDs, timestamps, titles, and message content
  with deterministic fixture values while preserving relationships between IDs.
- Ignore browser-only headers and transport details. Assert method, path,
  query, relevant JSON fields, status, and response shape.
- Decode HAR responses marked with `content.encoding: "base64"` before creating
  JSON fixtures.
- Do not persist the HAR files themselves in the repository.

## Verification targets

The HARs were captured from the authorized Open WebUI staging instance:

```text
HTTP base URL: https://owui.home.cowger.us
Socket.IO path: /ws/socket.io/
```

Live contract runs should take the target and credentials from the operator's
environment, for example:

```text
OPENWEBUI_REFERENCE_URL
OPENWEBUI_REFERENCE_TOKEN
```

For local runs, the repo-root `.env.openwebui.local` file is the gitignored
runtime source for these values, including the optional
`OPENWEBUI_REFERENCE_COOKIE`. Load it explicitly, for example:

```bash
bun --env-file=.env.openwebui.local run <contract-test-command>
```

Never commit, print, or include that file's contents in fixtures or logs. The
same test cases should run once against this reference target and later against
the Solar facade.

## Resolved realtime and management contracts

The following behavior is confirmed by Open WebUI source commit
`01f4282f1ffe0d6212f58d3afbeae21fffd0c4be` and a live staging probe:

- Socket.IO connects at `/ws/socket.io/` with `auth: { token }`; the HTTP
  bearer header is not used for the Socket.IO handshake.
- The client emits `user-join` with `{ auth: { token } }` and expects an
  acknowledgment containing `id` and `name`.
- Server chat events use the `events` channel and this envelope:
  `{ chat_id, message_id, data: { type, data } }`.
- Completion updates use `data.type === "chat:completion"`; incremental data
  contains OpenAI-style `choices[].delta`, and the terminal update has
  `data.done === true`.
- Chat task state is `GET /api/tasks/chat/<chat-id>`; cancellation is
  `POST /api/tasks/chat/<chat-id>/stop` with no request body.
- Folder writes are `POST /api/v1/folders/`,
  `POST /api/v1/folders/<id>/update`, and
  `DELETE /api/v1/folders/<id>?delete_contents=false`.
- The user tool catalog is `GET /api/v1/tools/`. Open WebUI's admin tool-server
  configuration replaces the complete `TOOL_SERVER_CONNECTIONS` array and is
  not the conversation-level Solar MCP toggle; the facade must map Solar's
  authorized MCP catalog instead of exposing that admin API.

## Captured cases

### OWUI-REST-001 — Start a chat completion

**Request**

```text
POST /api/chat/completions
```

Assert the request has the Open WebUI completion shape, including:

- `stream: true`
- a model identifier and model descriptor
- `params`
- `tool_servers`
- `features`
- `variables`
- the conversation/session identifiers and message context used by the
  captured client

Browser authentication values must be replaced with a test principal.

**Response**

```json
{
  "status": true,
  "task_ids": ["<task-id>"],
  "chat_id": "<chat-id>"
}
```

Assert HTTP `200`, `status === true`, a non-empty `task_ids` array, and a
non-empty `chat_id`. The task ID and chat ID must be usable by subsequent task
and history requests.

The HAR does not contain the Socket.IO frames that deliver the generated
content. This case therefore covers only completion acceptance; streaming is a
separate pending contract.

### OWUI-REST-002 — List chats

**Request**

```text
GET /api/v1/chats/?page=1
```

**Response**

Assert HTTP `200` and a JSON array of chat summaries. Each summary used by the
captured UI must include at least:

```text
id
title
created_at
updated_at
last_read_at
snippet
```

The facade must scope results to the authenticated user and preserve pagination
behavior.

### OWUI-REST-003 — Open an existing chat

**Request**

```text
GET /api/v1/chats/<chat-id>
```

**Response**

Assert HTTP `200` and an object with:

```text
id
user_id
title
chat.id
chat.title
chat.models
chat.history.currentId
chat.history.messages
```

For every history message, assert the tree fields and referential integrity:

```text
id
parentId
childrenIds
role
content
```

`currentId` must reference a message in `messages`; every child reference must
reference an existing message; and each child's `parentId` must point back to
the containing message.

The first Solar implementation should satisfy this using direct Solar IDs and
a synthesized single branch. If it cannot satisfy these assertions without a
second persistence model, the facade experiment is non-viable.

### OWUI-REST-004 — Check chat task state

**Request**

```text
GET /api/tasks/chat/<chat-id>
```

For an idle, loaded chat, the captured response is:

```json
{
  "task_ids": []
}
```

Assert HTTP `200` and an array-valued `task_ids`. An active completion should
return the corresponding task identifier.

### OWUI-REST-005 — Delete a chat

**Request**

```text
DELETE /api/v1/chats/<chat-id>
```

**Response**

Assert HTTP `200` and the literal JSON value:

```json
true
```

After deletion, the chat must no longer be returned by the list endpoint and
opening it must return the reference server's not-found behavior. The delete
operation must be user-scoped.

### OWUI-REST-006 — Refresh supporting chat state

The delete capture also exercises UI refresh calls that should have stable
basic responses:

```text
GET /api/v1/chats/<chat-id>/pinned  → boolean
GET /api/v1/chats/pinned           → array
GET /api/v1/chats/all/tags         → array
GET /api/v1/folders/               → array
GET /api/v1/folders/shared         → array
```

These are read-only compatibility cases. The executable reference suite also
covers the source-derived tool catalog, folder mutation, and stop routes behind
an explicit mutation flag.

## Remaining capture-derived cases

- Text delta ordering and terminal completion payload details beyond the
  source-confirmed event envelope.
- Reconnect/replay during generation.
- Tool-call lifecycle and tool results.
- Chat folder assignment and cross-device folder behavior.

Generation replay and tool lifecycle now have source-derived contracts; they
remain facade-level tests using Solar's mocked generation manager rather than
live staging mutations.
