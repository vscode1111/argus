---
name: dev
description: Start, stop, restart, open, or check the Argus development server.
---

# Argus development server

Work from the repository root. Interpret the requested mode as follows; default to `start` when none is given.

- `start`: run `yarn dev` in the background.
- `stop`: run `yarn dev:stop`.
- `restart`: stop, then start in the background.
- `status`: check the frontend on port 5173 and backend on port 3001, then report which are listening.
- `fe`: run `yarn dev:frontend` in the background.
- `be`: run `yarn dev:server` in the background.
- `open`: run `node scripts/launch.js`, passing a directory if the user supplied one.

Do not modify source files as part of server control.
