# Server Guidance

See root `AGENTS.md` for dev server commands, scripts, and the `SOLAR_MOCK_LLM=1` requirement.

## Entrypoint & Routing
- **Explicit `Bun.serve(...)`**: Must call `Bun.serve` explicitly (default export `{ fetch }` exits immediately).
- **Route Precedence**: Specific API routes (`/trpc/*`, `/api/auth/*`, `/healthz`) must be defined before the `/*` HTML catch-all in `Bun.serve`.
- **HTML Entrypoint**: Imported as module: `import index from "@solar/web/index.html"`.

## Development Seed
Fresh DB automatically seeds `admin@solar.local` / `password` + Dev API key (printed in startup log). Dev only.

## Database & Migrations
- **Auto-migrate on boot**: Kysely (`bun run migrate`) and Better Auth (`bun run migrate:auth` via `better-auth/db/migration`) run automatically on startup against `solar.db`.
- **Shared Dialect**: Single `bun:sqlite` instance passed to Kysely and Better Auth.
- **Codegen**: Run `bun run codegen` (`kysely-codegen --dialect sqlite`). Requires dev-dep `better-sqlite3`. Commit updated `types.generated.ts`.
- **Timestamps**: SQLite `CURRENT_TIMESTAMP` has second resolution; use explicit ms ISO timestamps for order-sensitive records.
- **Backups**: Persist `${SOLAR_PI_AGENT_DIR}` with `DATABASE_PATH` and the
  attachment root. Pi session JSONL is canonical conversation history; SQLite
  alone is not a complete chat backup. The pi directory also contains model and
  authentication state and should be treated as sensitive.

## Chat & Generation
- **Engine**: chat runs on the pi engine (`src/pi/`): one `pi --mode rpc` child process per actively-generating conversation; session JSONL under `${SOLAR_PI_AGENT_DIR}/sessions/<conversationId>` is canonical. There is no chat-v2 generation engine — surviving chat-v2 modules (`chat-v2/db/repository.ts` + siblings) are the migration/export archive layer only.
- **Decoupled execution**: generation streaming is owned by the pi child process; SSE disconnect does not cancel generation; use `POST /api/chat/stop` (pi `abort`).
- **Tools/MCP/skills**: resolved server-side and injected into the pi child via `pi/bridge/extension.ts` + the loopback `/internal/pi-bridge/*` endpoints.
- **Legacy import**: Use the root `scripts/import-chat-v2-to-pi.ts` script to
  pre-warm archived chat-v2 conversations. It uses the same
  `DATABASE_PATH`/`SOLAR_PI_AGENT_DIR` environment as the server.

## Tests
- **Isolation required**: ALWAYS run via `bun run test:server` (uses `--isolate`). Bare `bun test` leaks `mock.module` across files.
- **Attachments mock**: Tests importing `pi/engine.ts` must mock `./attachments` to avoid `@struktoai/mirage-node` load failures:
  ```ts
  mock.module("./attachments", () => ({
  	expandAttachmentRows: async () => ({ parts: [], documents: [] }),
  	deleteAttachmentFilesByStorageKey: async () => {},
  }));
  ```
