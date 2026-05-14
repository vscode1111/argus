---
description: Control the dev environment (start, stop, restart, or check status).
---

Manage the Argus development server (Vite frontend + WebSocket backend).

Argument: $ARGUMENTS

## Modes

- `start` (default) - start the dev server via `yarn dev`
- `stop` - stop running dev processes via `yarn dev:stop`
- `restart` - stop then start
- `status` - check if dev processes are running (look for node processes on ports 5173 and 3001)
- `fe` - start only the Vite frontend via `yarn dev:frontend`
- `be` - start only the WebSocket server via `yarn dev:server`
- `open` - launch Chrome in app mode via `node scripts/launch.js`

## Steps

1. Parse the argument. If empty, default to `start`.
2. For `status`, check for listening processes on ports 5173 and 3001. Report which are running.
3. For `stop`, run `yarn dev:stop`.
4. For `start`, run `yarn dev` in the background.
5. For `restart`, run stop then start.
6. For `fe` / `be`, run the corresponding command in the background.
7. For `open`, run `node scripts/launch.js`. Accept an optional directory path after `open` (e.g. `open D:\myproject`).

## Rules

- Always run from the project root `d:\_Projects\vscode1111\argus`.
- When starting, run in background so the user can continue working.
- Do not modify any source files.
