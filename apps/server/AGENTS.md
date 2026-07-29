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

## Chat & Generation
- **Decoupled execution**: Streaming runs on generation's own `AbortController` (`generationManager.ts`). SSE disconnect does not cancel generation; use `POST /api/chat/stop`.
- **Context replay**: Full pi `AssistantMessage` JSON (with model/usage/stopReason) is persisted in `message.parts` and replayed verbatim.

## Tests
- **Isolation required**: ALWAYS run via `bun run test:server` (uses `--isolate`). Bare `bun test` leaks `mock.module` across files.
- **Attachments mock**: Tests importing `chat/v2Live.ts` must mock `./attachments` to avoid `@struktoai/mirage-node` load failures:
  ```ts
  mock.module("./attachments", () => ({
  	expandAttachmentRows: async () => ({ parts: [], documents: [] }),
  	deleteAttachmentFilesByStorageKey: async () => {},
  }));
  ```
