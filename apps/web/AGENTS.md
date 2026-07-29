# Frontend Guidance

## Visual Verification
- Take browser screenshots to verify UI/styling changes (don't rely solely on DOM assertions).
- Wait for CSS/UI animations to settle before snapshotting.
- DaisyUI toggles MUST use primary color when checked: `toggle-primary checked:border-primary checked:bg-primary checked:text-primary-content`.

## Dev & Build
- **No separate web dev server / Vite**: Server bundles and serves React app with HMR via `bun-plugin-tailwind` in `apps/server/bunfig.toml`.
- **Production Build**: `bun run build` outputs to `apps/server/dist/web`.

## Runtime & Tests
- **Store Runtime**: Uses `useExternalStoreRuntime` for assistant-ui to support persisted chat history and reload/resume.
- **Unit Tests**: Run with `bun run test:web` (uses Bun test runner + Happy DOM).
