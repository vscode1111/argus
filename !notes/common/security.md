# Security Hardening

Applied 2026-05-31 based on a full codebase audit.

## WebSocket origin validation

`src/backend/index.ts` - the HTTP upgrade handler validates the `Origin` header before accepting WebSocket connections. Allowed origins: `vscode-webview:*`, `http(s)://localhost(:port)`, and empty origin (same-origin or non-browser clients). All other origins get `403 Forbidden`. This prevents cross-site WebSocket hijacking (CSWSH) where a malicious website could connect to the local server.

## Path traversal protection

`readFilePreview` handler in both `src/backend/index.ts` and `src/frontend/chat/ChatPanel.ts`: relative paths are validated to resolve within the workspace directory. Absolute paths are allowed (users click paths from Claude's responses, which can reference files outside the workspace). The check uses `path.resolve()` + `startsWith(workspaceDir + path.sep)`.

## Settings allowlist

`updateSettings` handler in `src/backend/index.ts`: incoming patch objects are filtered through `DEFAULT_CONFIG` keys before merging. Only known `ArgusConfig` fields are accepted, preventing arbitrary key injection.

## Process spawning

`killProc()` uses `execFileSync('taskkill', [...args])` instead of `execSync('taskkill /F /PID ${pid}')` to avoid shell interpretation. While `proc.pid` is always a number from Node.js, `execFileSync` is the safer pattern.
