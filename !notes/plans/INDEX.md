# Argus - Master Plan

All tracked issues, bugs, architecture decisions, and deferred ideas.
Status: **open** | **in-progress** | **deferred** | **implemented**

---

## Open Bugs / Issues

| Issue | Status | Summary |
|-------|--------|---------|
| [toast-click-focus-cross-desktop](../issues/toast-click-focus-cross-desktop.md) | **open** | Clicking the notify-on-complete Windows toast does not bring VS Code forward across virtual desktops. In-process Win32 approach (Attempt 2) proven to fail from the background extension host (`cleared=false`, `attached=false`). VBS -> PS1 foreground-righted helper (Attempt 3, commit f6b957b) is in working tree but **never verified** - `%TEMP%\argus-focus-helper.log` is absent. Two competing paths still wired; stale comment in ChatPanel.ts references a `watchFocusSignal` that does not exist. |

---

## Open Plans

| Plan | Status | Summary |
|------|--------|---------|
| [multi-device-live-session](multi-device-live-session.md) | **open** | Joining a running session from a second browser/phone should behave like a Telegram group chat: live streaming to every client at once, and stop/start from any device. Motivation: steer long desktop sessions remotely from a phone. Today every browser tab is isolated (`client=browser` -> `fresh: true` -> `createEntry()`), so a second tab gets no replay and a resume only shows the frozen on-disk transcript. Recommended fix: attach-by-sessionId with in-memory state winning over disk. **The connect-time subset now exists** via [session-deep-link](session-deep-link.md) (`channel.addClient(ws, fresh, sessionId)` live-attaches at upgrade); still open: attach-first in `handleResumeSession` (the Session History click path still replays from disk) and the channel-wide `liveIds` discovery field - today's `currentId` is the requesting client's own `s.sessionId`, so a fresh tab highlights nothing and cannot tell an attachable session from a frozen one. |
| [argus-sdk-migration](argus-sdk-migration.md) | **open** | Replace `claude.exe --print` subprocess spawning with the `@anthropic-ai/claude-code` SDK `query()` called in-process. Eliminates ~220 MB per session, zero separate processes. Auth via existing `claude login` session (subscription-compatible). Migration: add SDK dep, replace spawn+pipe in `cli.ts`/`cliHandler.ts` with async generator, map stream-json events, verify `--resume` and partial messages. |

---

## Deferred Ideas

| Idea | Status | Summary |
|------|--------|---------|
| [session-load-progress](session-load-progress.md) | **deferred** | Replace the indeterminate spinner on session resume with a determinate % progress bar. The dominant cost is the React render, so the bar must track chunked `requestAnimationFrame` renders (not the WS transfer). Requires `ChatMessage` to be `React.memo`'d first to avoid O(n^2) re-renders. Deferred 2026-06-24 as too large a change; approach is fully designed. |
| [chatmessage-memo](chatmessage-memo.md) | **deferred** | Wrap `ChatMessage` in `React.memo` to eliminate re-renders of already-shown messages when new ones arrive. Hard prerequisite for the progress bar; also a standalone win for long-session performance (e.g. a 17k-line session re-renders all messages on each streaming chunk today). `logCount` prop should only be passed to messages that actually use it (`background_waiting` outcome) to keep memo stable during streaming. |
| [prespawn-on-connect](prespawn-on-connect.md) | **deferred** | Spawn the Claude CLI when the WebSocket client connects (default args) so the first user message lands on a warm process. Benchmarked: cold run drops from 11.6s to 7.8s (avg 4.8s vs 6.5s for current reuse approach). Skipped for simplicity; revisit if first-message latency becomes a concern. |

---

## Implemented (history)

| Item | Commit | Summary |
|------|--------|---------|
| [panel-isolation-and-session-info](../tasks/panel-isolation-and-session-info/notes.md) | working tree | Per-panel session isolation (`?panel=<uuid>` -> `SessionEntry.owner`): two panels in one workspace no longer share a conversation, and a reload/daemon restart rejoins the panel's own entry. Plus Settings Info tab rows for the live session id + transcript path and for Client/Server versions, flagging a stale serving daemon (`readServerVersion()` in `src/backend/version.ts`). |
| [session-deep-link](session-deep-link.md) | working tree | `?session=<id>` in the URL: workspace resolved server-side from the transcript's cwd (`findWorkspaceForSession`, wins over a stale `?dir=`), live-attach at upgrade via `channel.addClient(ws, fresh, sessionId)`, disk replay fallback for finished sessions, replay deferred to `webviewReady` (avoids racing the React listener), copy-link button on Session History rows (browser mode), shims keep the param synced on newSession/resumeSession/switchWorkspace. e2e: `session-deep-link-integration.spec.ts`. |
| [shared-channel-broadcast](shared-channel-broadcast.md) | working tree | Multi-session channel per workspaceDir: `SessionEntry`-based registry; `newSession` creates an isolated entry (old proc keeps running); browsing clients gated from SESSION_STREAM_EVENTS; late joiners get history replay + streaming snapshot; Bug 1 (no-kill-on-resume) and Bug 2 (browsing stream gating) fixed. |
| Real-time token spending + ThinkingBlock | f3f19e5 | Live token counts in StreamingTimer via `message_start`/`message_delta`; collapsible ThinkingBlock with char-estimate in collapsed header. |
| Windows PID recycling fix + model-selection e2e | 3bcfc37 | Daemon single-instance guard handles PID recycling; e2e tests for model selection. |
| Effort/thinking model controls | 55d2caf | `effort` + `thinking` fields in config and UI; `--effort` flag passed to CLI; e2e tests. |
| [switch-model-slash-menu](switch-model-slash-menu.md) | 3bcfc37 | "Switch model..." in the slash menu with current model shown right-aligned; inline picker with checkmark; `switchModel`/`modelChanged` WS messages. |
| Single always-on daemon | b40812e | Fixed-port daemon (3017) with idle self-exit; auto-spawned by extension; browser-served UI; in-app restart; configurable `daemonPort`/`daemonIdleMs`; shared WS bridge factory. |
| Dialog state persistence | 241b9f6 / ea2c61e | Per-dialog position/size/tab persisted to `localStorage`; `useDialogGeometry` hook; Settings "Reset layout" button; `clearDialogState()`; e2e coverage. |
| Session history + workspace switcher | 587e427 / d5d817f | Session History modal (search, rename, delete, resume, All workspaces tab); Workspace History modal (Recent + Browse folder explorer with editable breadcrumb); line counts per session. |
| Account & Usage modal | 97d3635 | Live `/oauth/usage` API (primary) + stream `rate_limit_event` fallback; two-phase load; 429/401 error surfacing; refresh + 60s cache; e2e coverage. |
| Token streaming | 402357f | `--include-partial-messages` flag; `stream_event` unwrap in `cliHandler`; per-chunk `text_chunk` WS frames; e2e coverage. |
| Send while streaming | c45c246 | Mid-turn stdin inject without state reset; `user_inject` WS event + `UserInjectBlock` rendering; e2e coverage. |
| Security hardening | 60b56a1 | Nonce auth; Origin gate with `allowNetworkAccess` + `allowedOrigins`; mtime config cache; ReDoS guard on file paths. |
