# Security Audit - Argus

Audit date: 2026-05-13

## Critical

### 1. Arbitrary File Read via `readFilePreview`

**Files:** `src/argusServer.ts:715`, `src/chat/ChatPanel.ts:83`

Any WebSocket client can read any file on the machine by sending `{ type: "readFilePreview", path: "C:\\Users\\...\\id_rsa" }`. No validation that the path is inside the workspace directory.

**Fix:** Validate that the resolved path starts with `workspaceDir` before reading.

### 2. WebSocket Server Listens on 0.0.0.0

**File:** `src/argusServer.ts:752`

`httpServer.listen(PORT)` without a host binds to all network interfaces. In dev mode (port 3001), anyone on the local network can connect.

**Fix:** Bind to `127.0.0.1` explicitly.

## High

### 3. No Authentication on WebSocket Connections

**File:** `src/argusServer.ts:743`

No origin check, no token. Any webpage can connect to `ws://localhost:3001/agent` (cross-site WebSocket hijacking). Combined with #1 this allows silent file exfiltration from any browser tab.

**Fix:** Add a random session token to the WS URL; reject connections without valid token. Optionally also check `Origin` header.

### 4. Unsanitized `dir` Parameter Used as `cwd`

**File:** `src/argusServer.ts:171`

The `?dir=` query parameter goes directly to `spawn('claude', args, { cwd: workspaceDir })`. Attacker can point Claude CLI at any directory, including one with a malicious `CLAUDE.md` (prompt injection).

**Fix:** Verify `workspaceDir` exists, is a directory, and optionally restrict to known roots.

## Medium

### 5. CSP Allows `ws://localhost:*`

**File:** `media/chat.html:6`

Content Security Policy allows WebSocket connections to any localhost port. Should restrict to the actual server port.

**Fix:** Inject specific port into CSP: `connect-src ws://localhost:${port};`

### 6. No try-catch on WebSocket `JSON.parse`

**File:** `src/argusServer.ts:467`

Malformed WebSocket message crashes the connection handler.

**Fix:** Wrap in try-catch, ignore invalid messages.

### 7. Hardcoded Dev WebSocket URL

**File:** `webview/index.html:46`

Port 3001 is predictable, making port-scanning trivial for attackers.

**Fix:** Less critical if auth token is added (fix #3).

## Low

### 8. Arbitrary URL Opening via `openUrl`

**File:** `src/chat/ChatPanel.ts:78`

`vscode.env.openExternal()` with unvalidated URL from webview message. Could trigger phishing or protocol handler attacks.

### 9. Stderr Forwarded to Client

**File:** `src/argusServer.ts:416`

Claude CLI stderr goes to WS client as log entries; could leak sensitive info from error messages.

## Attack Scenarios

- **Drive-by hijack:** Any webpage silently opens `ws://localhost:3001/agent`, reads SSH keys/env files/credentials via `readFilePreview`, exfiltrates to attacker server.
- **Remote code execution:** Same WS connection sends a prompt that triggers Claude CLI's Bash tool to run arbitrary commands.
- **LAN attack:** Server on 0.0.0.0 means anyone on the same WiFi can connect without the victim visiting any page.
- **Workspace poisoning:** Attacker's repo contains malicious `.claude/CLAUDE.md` with prompt injection; opening with Argus executes it.
- **Extension marketplace risk:** If published as VS Code extension, every installer gets an unauthenticated WS server; webpages can port-scan localhost to find it.

## Recommended Fix Priority

1. Add random session token to WS URL (blocks all remote attacks)
2. Bind to `127.0.0.1` (blocks LAN attacks)
3. Validate `readFilePreview` paths against workspace root
4. Tighten CSP to specific port
5. Add try-catch on WS JSON.parse
