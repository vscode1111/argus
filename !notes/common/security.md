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

## Process termination - machine-wide (killAllClaude)

Added 2026-08-03 (`stop-all-claude-button` task). `killAllClaude()` in `src/backend/cli.ts` runs `execFileSync('taskkill', ['/F', '/IM', 'claude.exe'])` - same safe no-shell pattern as `killProc()`, but broader in scope: it targets every `claude.exe` on the machine by image name, not a specific pid this server spawned. It is deliberately **not** gated by any extra server-side authorization beyond the existing WS connection auth (nonce + Origin, see above) - any client that can reach the `killAllClaude` WS message already has full `send`/tool access on this connection, so a second server-side check would not raise the actual privilege boundary. The only friction is client-side UX (SettingsModal's two-click arm/confirm in the Info tab), which protects against misclicks, not against a malicious client.

## Rendering a file's own HTML

Added 2026-09-02 (`html-preview` task). The previewer renders `.html`/`.htm` in
`<iframe srcDoc sandbox="">` - the empty value is the maximum restriction (no scripts, no
forms, no same-origin), and it is deliberate rather than a default.

The content is not trusted: it is whatever the agent wrote or read off disk. A `<script>`
inserted through `innerHTML` would not execute, but an inline handler
(`<img src=x onerror=...>`) does, and a `srcdoc` frame inherits **this page's CSP**, whose
`connect-src ws: wss: http: https:` would let such a handler read the document and post it
out from the app's own origin, alongside the live WebSocket. So the frame gets no script
privileges at all, and a document that needs its script (a CDN mermaid export, say) shows
its static text instead.

If an "open in a real browser" action is ever added for those documents, that is a
different decision with a different threat model - the file then runs in the browser's
origin, not in Argus.

## Process termination - one pid, supplied by the client (killCliProcess)

The per-row terminate button in the CLI process modal sends a **pid chosen by the webview**.
Anything that can open a WebSocket to Argus (nonce + Origin, which is the whole
authorisation) could otherwise have the server kill **any process on the machine** - a clear
escalation from "can use Argus" to "can kill anything".

Two independent guards, and they were verified independently:

1. **The pid must appear in the current listing as a Claude CLI.** `killCliProcess` re-reads
   the process list and refuses a pid that is not there.
2. **The kill itself is filtered**: on Windows `taskkill /T /F /PID <pid> /FI "IMAGENAME eq claude.exe"`,
   so even in the sub-second window where a pid could die and be recycled, the OS declines to
   kill the stranger that inherited it. Verified against a `node.exe` decoy, which survived.

Removing guard 1 in a test left the runner alive because guard 2 caught it, which is how we
know they are genuinely independent rather than one check written twice.

**Success is decided by re-probing the pid**, never by the command's output: `taskkill`
prints "no matching process" in the OS display language *and still exits 0*. See
[../../../!notes/common/windows-process-introspection.md](../../../!notes/common/windows-process-introspection.md).

A refusal must reach the UI. The row is removed optimistically, so a silently-dropped
failure reads as a successful kill until the next poll quietly restores the process.
