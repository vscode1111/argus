# Argus - VS Code Extension

AI coding assistant powered by Claude, built as a VS Code extension.

## Project Structure

```
src/
  backend/
    index.ts            - WebSocket server setup, ping/pong, Origin validation, nonce auth, upgrade handler
    session.ts          - Per-connection orchestrator (WS message routing, send/stop/answer, state init)
    sessionState.ts     - SessionState interface and createSessionState factory (shared mutable state)
    cliHandler.ts       - CLI stdout event parsing (handleCliEvent), proc lifecycle (attachProcHandlers)
    watchdog.ts         - Timeout detection, auto-retry scheduling (createWatchdog)
    login.ts            - OAuth login flow orchestration (createLoginHandler)
    filePreview.ts      - Shared file preview reader (path validation, image detection, used by both backend and extension)
    cli.ts              - Claude CLI spawn helpers, process kill, allowed tools list
    config.ts           - ArgusConfig type, readConfig/writeConfig (mtime-based cache), DEFAULT_CONFIG
    skills.ts           - Slash command and skill discovery (readCommandsDir, readSkillsDir)
    accountUsage.ts     - fetchAccountInfo (claude auth status --json), fetchUsage (live /api/oauth/usage via OAuth token), parseRateLimitEvent (stream fallback)
    sessions.ts         - Local session history: listSessions/loadSession/deleteSession over CLI transcripts in ~/.claude/projects/<encoded-cwd>/*.jsonl (dir path-encoding, replay parser, traversal guards)
  frontend/
    extension.ts        - Activation entry point, starts WS server on dynamic port, registers commands/providers
    chat/
      ChatPanel.ts      - WebviewPanel lifecycle, VS Code-specific message handlers, injects WS URL into HTML
      ChatMessage.ts    - Message types
    providers/
      InlineSuggestProvider.ts  - Inline completions (Copilot-style)
      CodeLensProvider.ts       - "Ask Argus" code lens
    utils/
      config.ts         - Extension settings helpers
      workspace.ts      - VS Code workspace helpers
      win32Focus.ts     - Win32 FFI (koffi) for reliable SetForegroundWindow on notification click
      win32Clipboard.ts - Win32 FFI (koffi + GDI+) for copying images to system clipboard (CF_DIB + PNG)
cmd/
  start-argus.bat       - Launch dev server (double-click from Explorer)
  ctx-install.bat       - Install context menu entry (run as admin)
  ctx-uninstall.bat     - Remove context menu entry (run as admin)
  kill-claude.bat       - Kill all running Claude Code processes
server/
  index.ts              - Thin entry point for standalone dev mode (imports startServer from src/backend/index.ts)
  tsconfig.json         - TypeScript config for server
scripts/
  dev.js                - Orchestrates Vite frontend + WebSocket server in parallel (colored [fe]/[be] output, watches server/ and src/backend/)
  dev-stop.js           - Kill running dev processes
  context-menu.js       - Cross-platform context menu install/uninstall (Windows registry / Linux .desktop entry)
  launch.js             - Opens Chrome in app mode with optional ?dir= param (cross-platform Chrome paths)
  launch.vbs            - Windows-only VBS wrapper for windowless launch (invoked by context menu registry)
media/
  chat.html             - Webview HTML template (React mount point, placeholders injected by ChatPanel)
  argus-icon.ico        - App icon for context menu and favicon
  webview.js            - Bundled React app (gitignored, run `yarn build` to generate)
  webview.css           - Bundled styles (gitignored, run `yarn build` to generate)
e2e/
  helpers.ts            - waitForApp() shared helper (goto + React mount retry)
  argus.json            - Server config override for e2e (model, watchdog settings)
  chat-integration.spec.ts - Integration: send message, verify logs and response
  clear-integration.spec.ts - Integration: /clear command (no error, can send after, stop+clear)
  ask-dialog-integration.spec.ts - Integration: AskUserQuestion dialog interaction
  ask-dialog-resume.spec.ts - Mock: AskUserQuestion answer commit, follow-up, cancel
  ask-dialog-selection.spec.ts - Mock: AskUserQuestion option selection correctness (non-first, multi-select, multi-tab)
  ask-dialog-selection-integration.spec.ts - Integration: AskUserQuestion non-first option selection, verifies Claude response matches
  image-recognize-integration.spec.ts - Integration: paste image, verify text recognition
  slash-commands.spec.ts - Mock: slash command menu UI (filtering, scopes, keyboard nav)
  slash-commands-integration.spec.ts - Integration: real commands/skills from server
  stop-no-error.spec.ts - Mock: stop does not produce error blocks
  background-tasks.spec.ts - Mock: background task indicators and counters
  retry-clean.spec.ts   - Mock: retry cleanup of error messages
  retry-indicator.spec.ts - Mock: retry status indicator display
  file-path-links.spec.ts - Mock + WS: file path rendering and FileViewerModal
  file-viewer-modal.spec.ts - Mock: Read tool line highlighting cap, copy path button
  file-preview-copy-integration.spec.ts - Integration: copy path from Read tool file preview
  diff-viewer-scroll.spec.ts - Mock: DiffViewerModal horizontal scroll at narrow viewport
  image-copy.spec.ts    - Mock: ImageViewerModal open, copy, close, toast
  send-while-streaming.spec.ts - Mock: user_inject block rendering, ordering, copy, persistence, stop
  send-while-streaming-integration.spec.ts - Integration: mid-turn inject with real CLI, follow-up after inject
  streaming-partial-integration.spec.ts - Integration: long response arrives as multiple text_chunk WS frames (verifies --include-partial-messages flag is wired)
  account-usage.spec.ts - Mock: Account & Usage modal (menu entry, account rows, usage bar sorting/percent/color/reset, empty hint, logged-out, Escape)
  account-usage-integration.spec.ts - Integration: real account info from claude auth status; usage windows after a real rate_limit_event
  session-history.spec.ts - Mock: Session History modal (open via history button, list/sort, current badge, search filter, optimistic delete, sessionLoaded replay, Escape)
  session-history-integration.spec.ts - Integration: create a real session, list it, resume it (replay + current badge), verify context continues via --resume
  workspace-browse-integration.spec.ts - Integration: Workspace History "Browse" tab folder explorer over real listDir (lists home folders, walks up to "This PC"/drives and back, opens a browsed folder as the workspace)
  workspace-browse-edit-integration.spec.ts - Integration: Workspace History "Browse" editable breadcrumb over real listDir (typing a valid path navigates there; an invalid path falls back to the nearest existing directory)
  log-autoscroll-integration.spec.ts - Integration: debug log stays pinned to the bottom through a full stream (regression for mid-stream autoscroll break)
webview/
  vite.config.ts        - Vite lib-mode build config (IIFE, outputs to media/)
  vite.dev.config.ts    - Vite dev server config (port 5173, HMR)
  tsconfig.json         - TypeScript config for webview (JSX, ESNext)
  index.html            - Dev entry point with VS Code variable mocks (Dark+ theme)
  src/
    index.tsx           - React entry point (production)
    index.dev.tsx       - React entry point (dev, mounts App + DevHarness)
    App.tsx             - Root component, effects (sound/notification/streaming state), layout
    reducer.ts          - AppState/AppAction types, reducer function, initialState, block finalization helpers
    types.ts            - Shared types (UIMessage, StreamingState, ToolCallData, ContentBlock, ErrorKind, LoginState, RetryStatus, Outcome)
    vscode.ts           - acquireVsCodeApi() singleton + postMessage helper
    global.css          - :root vars, resets, body, .app, .btn-icon utility
    css-modules.d.ts    - TypeScript ambient declaration for *.module.css
    components/
      shared/
        message.module.css  - Shared message styles (layout, markdown content)
        modal.module.css    - Shared full-screen modal shell (FileViewer/DiffViewer)
        EncodingSelect.tsx / encoding.module.css - Encoding dropdown for re-decoding garbled text
      Header.tsx / .module.css
      MessageList.tsx / .module.css
      ChatMessage.tsx / .module.css
      StreamingMessage.tsx    - Uses shared/message.module.css
      StreamingTimer.tsx      - Uses shared/message.module.css
      ThinkingBlock.tsx / .module.css
      ToolCall.tsx / .module.css
      UserInjectBlock.tsx   - Mid-turn user inject bubble with hover copy button (uses shared/message.module.css)
      FileViewerModal.tsx / .module.css  - Uses shared/modal.module.css
      DiffViewerModal.tsx / .module.css  - Uses shared/modal.module.css
      ImageViewerModal.tsx / .module.css
      InfoModal.tsx / .module.css
      AccountUsageModal.tsx / .module.css  - Centered portal modal: account details + per-window usage bars
      SessionHistoryModal.tsx / .module.css  - Centered portal modal: search, per-session rows (title + relative time + delete), resume on click
      WorkspaceMenu.tsx / .module.css  - Header workspace tile button (cwd basename) that opens WorkspaceHistoryModal
      WorkspaceHistoryModal.tsx / .module.css  - Centered portal modal with Recent (listWorkspaces) and Browse (listDir folder explorer) tabs; picking a folder switches the workspace
      SettingsModal.tsx / .module.css  - Centered modal with tabs (General/Watchdog/Info), includes NumberInput component
      InputArea.tsx / .module.css
    hooks/
      useEscapeKey.ts   - Shared hook for Escape-to-close on modals
      useEncoding.ts    - Shared hook for encoding state + memoized decode
    dev/
      DevHarness.tsx    - Centered modal of mock-action buttons, fires mock extension messages for browser testing
    utils/
      markdown.tsx      - react-markdown wrapper with VS Code CSS variable styling
      filePath.tsx      - Clickable file path detection and linkification (FilePathLink + linkifyPaths + withLinkedPaths)
      text.ts           - plural() helper for count-dependent singular/plural labels
      path.ts            - basename() for Windows/Unix path last segment (workspace folder name)
      time.ts           - formatDuration and formatTime helpers
      encoding.ts       - ENCODINGS list and tryDecode() for charset re-interpretation
```

## Key Conventions

- Model: agent model is free-text (`argus.model`); empty/unset defers to the Claude CLI default. Inline completions default to `claude-haiku-4-5` (fast/cheap tier required)
- Streaming: always use `client.messages.stream()` + `finalMessage()`
- Tool approval: destructive tools (write_file, bash) require user confirmation via `showWarningMessage`
- No Python scripts - use Node.js/TypeScript for any tooling
- Webview UI is React 18 + TypeScript + Vite (lib/IIFE mode). Build with `yarn build`
- Webview styling uses CSS Modules (co-located `.module.css` files) with VS Code CSS variables (`var(--vscode-*)`) - no Tailwind, auto-adapts to any theme
- CSS Modules: camelCase class names for dot access (`styles.toolCall`), conditional classes via `.filter(Boolean).join(' ')`, shared modules in `components/shared/`, `composes:` for reuse
- CSS color tokens: diff/semantic colors defined as CSS variables in `global.css` (`--diff-added`, `--diff-removed`, `--user-msg-bg`, etc.) - never hardcode color literals in component CSS
- Webview markdown rendered via `react-markdown` in `utils/markdown.tsx`
- Webview message protocol (extension -> webview): typed as `WebviewMessage` union in `ChatPanel.ts` - `thinking_start | thinking_chunk | text_chunk | tool_start | tool_end | done | error | message | clear | prefill | skills | workspaceInfo | log | clearLogs | loginUrl | loginResult | contextUsage | filePreview | retry_status | retry_clean | copyImageResult | user_inject | accountUsage | sessionList | sessionLoaded | workspaceList | dirList`
- Webview message protocol (webview -> extension): `send | stop | forceError | newSession | openFile | openUrl | getInfo | getSkills | retry | toolAnswer | login | loginCode | focusPanel | readFilePreview | copyImage | getAccountUsage | listSessions | resumeSession | deleteSession | renameSession | listWorkspaces | switchWorkspace | listDir`
- Modal Escape handling: use `useEscapeKey(onClose)` hook from `hooks/useEscapeKey.ts` - do not duplicate keydown listeners
- Modal portals: FileViewerModal, DiffViewerModal, and ImageViewerModal use `createPortal(jsx, document.body)` to render outside the React tree, avoiding z-index stacking issues when modals are opened from inside the scrollable MessageList during streaming
- Errors use `showError()` helper in ChatPanel - shows VS Code error notification with "View Output" action
- AgentSession and ChatPanel use a shared `vscode.OutputChannel` ("Argus") for stderr and error logging
- Image paste: clipboard images are base64-encoded in the webview, sent via `--input-format stream-json` NDJSON to the Claude CLI with `type: "image"` content blocks
- Image copy: ImageViewerModal has a toolbar with copy and close buttons; copy button and Ctrl+C shortcut copy the displayed image to system clipboard; in VS Code extension mode, sends `copyImage` message with base64 data to ChatPanel, which writes a temp PNG and calls `copyImageToClipboard()` from `win32Clipboard.ts` (GDI+ loads the image, converts to CF_DIB + registered PNG format, sets both via Win32 clipboard API); in browser dev mode, `copyImageBrowser` converts data URLs to blobs via `dataUrlToBlob()` (base64 decode, no `fetch()` since Chromium blocks `fetch()` on data URLs), then writes via `navigator.clipboard.write()` with `ClipboardItem`; toast shows "Copied to clipboard" or "Failed to copy image"; `copyImage` is routed via VS_ONLY in `chat.html`; e2e tests in `e2e/image-copy.spec.ts`
- Slash commands: InputArea shows a dropdown when "/" is typed; sends `getSkills` to extension, receives `skills` response with `{ name, scope: 'builtin' | 'global' | 'project', description? }[]`; commands read from `~/.claude/commands/` (global) and `<workspace>/.claude/commands/` (project) as `.md` files with YAML frontmatter `description:` field; skills read from `~/.claude/skills/` (global) and `<workspace>/.claude/skills/` (project) via `SKILL.md` frontmatter; built-in commands hardcoded in `src/backend/index.ts`; `readCommandsDir` parses frontmatter for description, falls back to first non-frontmatter line; Tab or Enter selects highlighted skill; description truncated to 100 chars in dropdown; e2e tests in `e2e/slash-commands.spec.ts` (mock) and `e2e/slash-commands-integration.spec.ts` (integration)
- Log panel: has its own settings dropdown (gear icon) with toggles for show time / show type; settings persisted via `SettingsContext` to localStorage (`argus.showLogTime`, `argus.showLogType`); log text is color-highlighted by content: "Spawning claude" entries render green (`textSpawn`), "exited with code" entries render orange (`textExit`)
- Error handling: errors classified into `ErrorKind` (`auth | not_found | session | generic`) via `classifyError()` in `src/backend/index.ts`; webview shows structured error blocks with contextual actions (Login, Retry, New session); API errors delivered as text content (e.g. "API Error: 403") are detected via a 3-second stale timer in the server and converted to error+done events; if `error` arrives after `done`, the reducer retroactively marks the last assistant message's outcome as `'error'`
- Login flow: `AgentSession.startLogin()` spawns `claude auth login`, captures OAuth URL, accepts auth code via stdin; webview `LoginPanel` in `ChatMessage.tsx` manages the UI; `LoginState` tracks phases (`idle | starting | url | submitting | success | error`)
- Retry: server stores `lastMessage`; webview sends `retry` message; server sends `retry_clean` (reducer removes trailing error-role messages and re-marks error-outcome assistant messages as `retried` to preserve content history) then re-emits as `send` with `_silent: true` (no duplicate user message); `thinking_start` is always sent regardless of `_silent` so streaming state initializes; retried messages show a compact yellow timer with "reconnected Nx" text instead of the full error block; e2e tests in `e2e/retry-clean.spec.ts`
- Sound on complete: `playCompletionSound()` in `App.tsx` via AudioContext; toggled by `soundOnComplete` setting in `SettingsContext`; suppressed when user manually stops the session (`outcome === 'stopped'`)
- Notify on complete: browser `Notification` API fires when streaming finishes (if `notifyOnComplete` enabled in `SettingsContext`); requests permission on first enable; notification title includes project name, body shows last user message; clicking focuses the window; suppressed on manual stop
- Copy buttons: user messages have a hover-reveal copy button (`MessageCopyButton` in `ChatMessage.tsx`); code blocks have a hover-reveal copy button (`CopyButton` in `utils/markdown.tsx`) styled via `global.css` (`.code-block-wrapper` / `.code-copy-btn`)
- SettingsModal: fixed centered modal with 3 tabs (General, Watchdog, Info); selected tab persisted to localStorage (`argus.settingsTab`); General tab has toggles for verbose tools, show timer, show output, show logs, sound/notify on complete; Watchdog tab has enabled toggle + NumberInput fields for timeout, auto retries, base delay, delay factor (disabled when watchdog off); Info tab shows version and workspace path (replaced standalone InfoModal); all setting labels have `title` tooltips; `NumberInput` component uses local string state for editing UX, allows empty field while focused, falls back to `min` value on blur; on mount, sends `getSettings` to re-fetch current server config (prevents stale cached values)
- Dev harness toggle: SettingsModal "dev" button dispatches `devharness-toggle` custom event; DevHarness listens and toggles its own `visible` state (returns `null` when hidden); available in both browser dev and VS Code extension mode (`#dev-harness` div in both `index.html` and `chat.html`); state persisted to localStorage (`argus.showDevHarness`). Rendered as a centered modal (`DevHarness.module.css`: overlay + `.modal` box with header/close, wrapped button grid in `.body`), not a portal - the buttons stay inside `#dev-harness` so e2e `document.querySelectorAll('#dev-harness button')` queries still work; closes on Escape (`useEscapeKey`), overlay click, or close button; clicking any mock-action button runs the action **and** closes the modal so the overlay never intercepts later real clicks (e.g. file-path links in `file-path-links.spec.ts`)
- Editor title icon: `argus.openChat` command registered in `editor/title` menu group with `media/argus-icon.svg` icon
- Global scrollbar styling: thin scrollbars via `scrollbar-width: thin` and `::-webkit-scrollbar` rules in `global.css`
- Content blocks: streaming and completed messages use `ContentBlock[]` (interleaved `{ type: 'text' }` and `{ type: 'tool' }` blocks) instead of separate text/toolCalls fields - preserves tool-call ordering relative to text
- Pluralization: `plural(count, singular, pluralForm?)` in `webview/src/utils/text.ts` for UI labels (e.g. "1 file" / "3 files"); inlined copy in `src/backend/cli.ts` (can't share .ts imports across the frontend/backend tsconfig boundary)
- AskUserQuestion: tabbed dialog UI (`askDialog`, `width: fit-content`) - multiple questions shown as tabs, supports single-select (radio dots) and multi-select (checkboxes via `multiSelect` flag), includes automatic "Other" option with free-text input (injected client-side in ToolCall.tsx); full-width submit button; text blocks after a pending AskUserQuestion are hidden so the AI appears to wait; cancelled dialogs show "Session ended"; completed answers show a formatted result summary strip (`askResultSummary`) with `"question"="answer"` pairs; `tool_end` events can update completed messages (not just streaming) for late answers; `AskUserQuestion` blocked in plan mode; `AskUserQuestion` excluded from `--allowedTools` so CLI prompts the server rather than auto-approving. Answer flow: `pendingFollowUp` stores answered questions until CLI `result` event; `flushAskFollowUp()` sends a `_silent` follow-up message with structured answer details (option index, description) so the AI proceeds with exact selections; `suppressCliOutput = true` on `AskUserQuestion` tool echo to hide CLI's own tool result text; watchdog interval skips ticks when `pendingAskTools.size > 0` to avoid false timeouts during user interaction; duplicate `tool_start` prevented via `toolMap.has()` and `answeredTools.has()` guards in the `assistant` event handler
- Pending tool animation: tool names pulse (green, `toolNamePending` class) while awaiting result; `pending` flag derived from `!result && !error`; on `done` or `error`, any still-pending tool blocks are marked `error: true` so they stop pulsing
- Clickable file paths: `utils/filePath.tsx` detects absolute paths (Windows and Unix) with optional `:line` or `:line-endLine` suffix in user messages and markdown output; `linkifyPaths()` for plain text, `withLinkedPaths()` for React children (recursively walks into nested elements like `<strong>`, `<code>`, `<td>`); clicking opens `FileViewerModal`; `readFilePreview` / `filePreview` message pair fetches file content from extension; `openFile` supports `line` parameter to jump to a specific line; styled via `.file-path-link` in `global.css`; `protectPathBackslashes()` in `markdown.tsx` escapes Windows backslashes before markdown parsing; `FileViewerModal` scrolls to the target line and highlights the range with `--diff-added-bg`; highlight capped at 30 lines max (ranges > 30 lines skip highlighting, prevents entire-file highlight from Read tool `:1-80` ranges); SyntaxHighlighter uses `transparent` background (inherits from modal); `FileViewerModal` header has a copy-path button (always visible, copies file path to clipboard with checkmark feedback); ToolCall passes `line`/`endLine` from Read tool `offset`/`limit` input to FileViewerModal for range highlighting; e2e tests in `e2e/file-path-links.spec.ts`, `e2e/file-viewer-modal.spec.ts`, `e2e/file-preview-copy-integration.spec.ts`
- Dev theme: `webview/index.html` uses Dark 2026 theme variables (extracted from VS Code state DB) to match the user's VS Code appearance in browser dev mode
- Log panel close: LogPanel has a close button (X) that calls `onClose` prop, which toggles `showLogs` off via `setShowLogs(false)` in App
- Multi-panel support: `ChatPanel` tracks all open panels in a static `Set<ChatPanel>` with a `lastFocused` pointer; `createNew()` always opens a fresh panel, `focusOrCreate()` reveals the last-focused one; `argus.openChat` creates new panels, other commands reuse the last-focused panel
- Win32 focus: `win32Focus.ts` uses `koffi` FFI to call `SetForegroundWindow`/`BringWindowToTop`; `captureForegroundWindow()` is called on panel creation, `focusCachedWindow()` on notification click via the `focusPanel` webview message
- Unified WebSocket server: `src/backend/index.ts` exports `startServer({ port, model })` returning `{ httpServer, port, nonce, close }`, used by both the VS Code extension (dynamic port via `port: 0`) and standalone dev mode (`server/index.ts`, port 3001); the extension starts the server on `activate()` and shuts it down on `deactivate()`; `ChatPanel` injects the WS URL (`ws://localhost:PORT/agent?nonce=...&dir=...`) into `chat.html`; the webview connects via a shim script that routes Claude-related messages to WS and VS Code-specific messages (`openFile`, `openUrl`, `focusPanel`, `getInfo`, `readFilePreview`, `copyImage`) to real `postMessage`; one port serves many panels (per-connection isolated state); `scripts/dev.js` starts both Vite and server in parallel, watches `server/` and `src/backend/` for auto-restart
- Directory-aware launch: context menu passes `?dir=` query param to the dev URL; `index.html` forwards it to the WebSocket (`ws://localhost:3001/agent?dir=...`); server reads `dir` from the upgrade request and uses it as `cwd` for Claude CLI spawns and skill discovery; `App.tsx` dispatches `workspaceInfo` on mount if `dir` is present
- Response time and outcome: completed assistant messages store `responseTime` (ms), `finishedAt` (timestamp), and `outcome` (`'success' | 'stopped' | 'error' | 'retried'`); timer text is color-coded: green (`responseTimeSuccess`) for success, blue (`responseTimeStopped`, `--vscode-charts-blue`) for stopped, red (`responseTimeError`, `--vscode-errorForeground`) for error, yellow (`responseTimeRetried`, `--vscode-editorWarning-foreground`) for watchdog-retried; retried messages show compact timer with "reconnected Nx" suffix (always visible regardless of `showTimer` setting); finish time shown in brackets e.g. "8s (02:15:35)"; `StreamingTimer` shows elapsed+idle during streaming; `InputArea.onStop` dispatches `stop` action to set `streaming.stopped = true` before `done` commits the message
- Log panel performance: log entry text uses `max-height: 4.5em` + `overflow: hidden` to cap visual height; `.logPane` uses `contain: inline-size` to prevent content from affecting parent layout width during reflow (prevents layout glitch on VS Code tab switch); server truncates debug event logs to 120 chars; `word-break: break-word` instead of `break-all` for natural line breaks
- Log panel autoscroll: `LogPanel.tsx` keeps the list pinned to the bottom as entries arrive and only pauses when the user deliberately scrolls **up**. `handleScroll` flips `userScrolledUp` to true only on an actual upward `scrollTop` move (tracked via a `lastScrollTop` ref), and back to false when within 80px of the bottom; it never sets it from content growth or from the panel's own async `scrollIntoView` (both of which keep or increase `scrollTop`). The `[logs]` effect autoscrolls whenever `!userScrolledUp` rather than gating on a fixed distance-from-bottom threshold - the earlier threshold (`dist < 200`) broke mid-stream when a burst appended more than the threshold in one render and never re-engaged. The scroll container has `data-testid="log-list"`; regression covered by `e2e/log-autoscroll-integration.spec.ts`
- DiffViewerModal: side-by-side diff with `pairRows()` that groups consecutive removes/adds into paired `change` rows (no empty-cell gaps); `pre-wrap` + `word-break: break-word` for long lines; `minmax(320px, 1fr) minmax(320px, 1fr)` grid columns ensure each side stays readable at narrow widths; `.scroll` wrapper div between `.body` and `.table` absorbs `modal.body > *` overflow rules, enabling horizontal scroll when viewport is too narrow for both 320px columns; e2e tests in `e2e/diff-viewer-scroll.spec.ts`
- Tool summary tooltips: `title` attribute on all `toolSummary` spans/links (file paths, Bash commands) so truncated text is visible on hover
- DevHarness stress test: "10K" button generates 10,000 log entries + 20 multi-tool assistant messages for layout/performance testing; "diff" button simulates two Edit tool calls (markdown + TypeScript refactor) for DiffViewerModal testing; "reads" button simulates three Read tool calls including offset/limit variants (`:1-80` and `:5-20` summaries) for FileViewerModal line highlighting testing
- Context usage indicator: pill in InputArea (`contextPill`) shows "X%" of 200k context window (full "X% used" in tooltip); extracted from CLI `assistant` event's `message.usage` (sums `input_tokens + cache_read_input_tokens + cache_creation_input_tokens + output_tokens`); color-coded: default <50%, yellow (`contextMedium`) 50-80%, red (`contextHigh`) 80%+; tooltip shows token breakdown; persists across messages (instance-scoped counters in ChatPanel), resets on clear/new session; ignores synthetic events (zero usage) from slash commands like `/context`
- Watchdog: extracted to `src/backend/watchdog.ts` (`createWatchdog`); interval-based health check every 5s; compares elapsed time since last JSON event from CLI stdout (`lastEventTime`) against `watchdogTimeout` config (min 10s, default 120s); can be disabled via `watchdogEnabled` (default true); auto-retries up to `watchdogAutoRetries` (default 3) with configurable exponential backoff: `delay = watchdogRetryDelay * watchdogDelayFactor^attempt` (defaults: base 5s, factor 2, producing 5s/10s/20s); `watchdogRetrying` flag prevents the proc close handler from sending premature `done` during retry; on retry, `retry_status` handler commits current streaming blocks as a completed `retried` message (preserves progress history) then clears streaming for the new attempt; `thinking_start` inherits `retryStatus` and `watchdogRetries` from previous streaming so "Reconnecting (N/M)" indicator persists across attempts; each committed retried message shows a yellow timer with "reconnected Nx" text (always visible regardless of `showTimer` setting); when all retries exhausted, sends `retry_status` with `timedOut: true` + `done` to end the session; `cliDone = true` on timeout prevents late stdout events from creating phantom sessions; pending retry timers are cancelled on timeout; redundant "Something went wrong" error messages suppressed when watchdog block already present; server `stop` handler sends `done` directly when proc is already dead; `watchdogRetries` tracked in `StreamingState` and persisted to `UIMessage` for timer display; e2e tests in `e2e/retry-indicator.spec.ts`
- Background tasks: CLI `run_in_background: true` Bash tools produce `task_started`, `task_updated`, `task_notification` system events; server tracks pending tasks in `pendingBgTasks` Set and `totalBgTasks` counter (both reset at each user-initiated turn); `done` event includes `pendingBackgroundTasks` and `totalBackgroundTasks` when tasks are pending; reducer creates `background_waiting` outcome messages with `bgTasksCompleted`/`bgTasksTotal` on `UIMessage`; `WorkingIndicator` shows "Waiting 1 background task" for 1 task, "Waiting N background tasks (completed/total)" for multiple, with live elapsed timer and idle time on a separate line; `task_notification` triggers a `tool_end` event with summary + output file content (`fs.readFileSync`) to update the original tool call result; `tool_end` reducer checks streaming blocks first, falls through to completed messages for late updates; Out link pulses green (`toolOutLinkRunning` class, reuses `toolPulse` animation) while result starts with "Command running in background", stops when result is updated or session ends; `sessionDone` prop passed from ChatMessage to ToolCall excludes `background_waiting` and `background_done` outcomes so Out links keep pulsing for still-running tasks; previous `background_waiting` messages are resolved to `background_done` (no indicator, no timer) when a new `done` arrives; e2e tests in `e2e/background-tasks.spec.ts`
- Token streaming: CLI spawn args include `--include-partial-messages` so the CLI emits `stream_event` envelopes containing inner `content_block_delta` events; `handleCliEvent` in `cliHandler.ts` unwraps `stream_event` (reads `event.event`) before dispatching to `handleDelta`; without the flag the CLI only sends the final `assistant` message in one block, producing a long delay then a single big drop; the WS layer forwards each `text_delta` as a `text_chunk` frame; e2e coverage in `e2e/streaming-partial-integration.spec.ts` intercepts WS frames (Playwright `page.on('websocket')`) and asserts that a 200+ char response arrives as >= 3 chunks with no single chunk exceeding 70% of total length
- Send/Stop buttons: icon-only SVG buttons with `aria-label` (preserves `getByRole('button', { name: 'Send' })` queries in Playwright tests); arrow up SVG for Send, filled square SVG for Stop; both share a `.sendRow` flex container under `.btnGroup` with `align-self: stretch` so width matches the row above; both buttons have `flex: 1` so they split 50/50 when Stop is visible (streaming), Send fills the row when Stop is hidden; `min-width: 70px` on Send prevents it from shrinking below the original "Send" text button width
- Send while streaming: Send button and Enter key are not blocked during streaming; when a message arrives mid-turn (`!cliDone && stdin writable`), `handleSend` writes it to CLI stdin silently (no user message event, no state reset) and returns; the CLI merges the injected message into the active turn, so the AI sees it in context and responds inline (matching native Claude Code behavior); if the turn has already completed, normal `handleSend` flow runs (spawn/reuse, `thinking_start`, etc.); backend sends `user_inject` WS event with the injected text; `cliHandler.ts` `handleUserEvent` also emits `user_inject` when the CLI echoes back user text blocks; reducer appends `{ type: 'user_inject', text }` to streaming `ContentBlock[]`; `UserInjectBlock.tsx` renders as an inline bubble (user-bg color, `fit-content` width, rounded corners) with a hover-reveal copy button; blocks are preserved in committed messages and maintain correct ordering between tool calls; styled via `.userInject` / `.userInjectCopy` in `shared/message.module.css`; e2e tests in `e2e/send-while-streaming.spec.ts` (mock) and `e2e/send-while-streaming-integration.spec.ts` (integration)
- Account & Usage: InputArea slash menu surfaces an "Account & usage..." action (under a "Model" sub-header) when the slash query is a prefix of "account"/"usage" (e.g. typing `/usage`); not shown on a bare `/`; selecting it opens `AccountUsageModal` (centered `createPortal` modal). Account section comes from `claude auth status --json` via `fetchAccountInfo()` in `src/backend/accountUsage.ts` (resolves `{loggedIn:false}` on error). Usage bars come **primarily** from the live Anthropic usage API: `fetchUsage(force?)` reads the OAuth `accessToken` from `~/.claude/.credentials.json` (runtime read, never logged/persisted) and `GET`s `https://api.anthropic.com/api/oauth/usage` with `anthropic-beta: oauth-2025-04-20` (60s `usageCache`, bypassed when `force` is true); the response has one object per window `{ utilization: <percent 0-100>, resets_at: <ISO|null> }`; `parseUsageResponse()` keeps only known windows (`KNOWN_USAGE_WINDOWS`: five_hour/seven_day/seven_day_opus/seven_day_sonnet) and normalizes utilization to 0..1 and resets to unix seconds. This loads all windows immediately, before any message is sent (matching the official panel). **Fallback**: streamed CLI `rate_limit_event`s (`parseRateLimitEvent` extracts `rate_limit_info` with `utilization` already 0..1 and `resetsAt` unix seconds) accumulate into `s.rateLimits` (`Map<string, RateLimitInfo>` keyed by window, latest wins, reset per connection) and are used when the API call fails (missing/expired token, offline). The webview sends `getAccountUsage`; `session.ts` replies in **two phases** so the account renders immediately instead of waiting on the slow/rate-limited usage fetch: phase 1 sends `accountUsage` `{ account, usagePending: true }` as soon as `fetchAccountInfo()` resolves; phase 2 (`Promise.all([accountP, usageP])`) sends `{ account, rateLimits, usageError?, usagePending: false }`. `fetchUsage(force)` returns `UsageResult { windows, error? }` where `error` is a short reason ("rate limited (HTTP 429)", "token expired (HTTP 401)", "request timed out", etc.); `rateLimits` uses API windows if non-empty, else accumulated stream windows; `usageError` is forwarded only when `rateLimits` is empty (no fallback to show). Modal tracks `accountLoading` (whole-body "Loading...") and `usageLoading` (usage section) separately; on a `usagePending` message it sets the account and returns early (keeps existing bars, leaves usage loading). Empty-state hint is state-aware: "Loading usage data..." while `usageLoading`, else "Usage data is unavailable: &lt;error&gt;." when `usageError` is set, else "Usage data is unavailable right now.". The refresh icon spins and is disabled while `usageLoading`. Modal maps windows to labels (`five_hour`->"Session (5hr)", `seven_day`->"Weekly (7 day)", `seven_day_sonnet`->"Weekly Sonnet", `seven_day_opus`->"Weekly Opus", unknown prettified), sorts by fixed order; percent = `round(utilization*100)` clamped 0-100; bar color tiers: base <50, medium (`--vscode-editorWarning-foreground`) 50-89, high (`--vscode-errorForeground`) >=90; a refresh icon (Feather refresh-cw) beside the "Usage" header re-requests with `getAccountUsage` `{ force: true }` (server passes `force` to `fetchUsage`, bypassing the cache) and spins (`refreshing` class) until the next `accountUsage` reply; footer "Manage usage on claude.ai" (-> `https://claude.ai/new#settings/usage`) does both `postMessage({type:'openUrl'})` (VS Code, `vscode.env.openExternal`) and `window.open` (browser dev, where the WS bridge has no `openUrl`). e2e tests in `e2e/account-usage.spec.ts` (mock) and `e2e/account-usage-integration.spec.ts` (integration, incl. a test asserting rendered percents match a live `/oauth/usage` fetch within ±2%)
- CLI stdin error handler: `proc.stdin.on('error', ...)` in `attachProcHandlers` (`src/backend/cliHandler.ts`) prevents the server from crashing when the CLI process dies unexpectedly (e.g. Bun panic); without it, a `write EOF` error on stdin propagates as an unhandled event that kills the Node.js server and drops all WebSocket connections
- Process lifecycle on `/clear`: `/clear` handler detaches `currentProc` (sets to `undefined`) before calling `killProc()`, so the proc close handler sees `isActiveProc === false` and skips error/done events; without this, force-killed process exit code triggers a spurious "Something went wrong" error block; e2e tests in `e2e/clear-integration.spec.ts`
- Security hardening: WebSocket upgrade handler validates `Origin` header (allows `vscode-webview:` and `localhost`, rejects cross-site connections) and requires a per-session `nonce` query param (generated via `crypto.randomBytes`, returned from `startServer`, validated on upgrade - returns 401 if missing/wrong); `workspaceDir` validated with `resolve()` + `isAbsolute()` + `existsSync()` before use (returns 4400 close on invalid); `readFilePreview` validates relative paths stay within workspace directory (absolute paths allowed for user-clicked links); `updateSettings` filters patch keys through `DEFAULT_CONFIG` allowlist; `killProc` uses `execFileSync` instead of `execSync` to avoid shell interpretation; WebSocket ping/pong tracking uses `WeakMap<WebSocket, boolean>` instead of `as any`; in dev mode, nonce served via `GET /nonce` HTTP endpoint (CORS-enabled) and fetched by `index.html` via sync XHR before WS connect; `.dev-nonce` file written by server for `launch.js` to read
- Top-right header actions: `App.tsx` renders a `.topRightActions` cluster anchored to `.chatPane` (which is `position: relative`, the cluster's containing block) so it clears the log panel instead of overlapping it. It holds a left-aligned **session name** label (white `var(--fg)`, derived in `App.tsx` from `sessionList` replies by matching `currentId`; re-fetched when a turn finishes, on `sessionLoaded`, and reset on `clear`), two icon buttons matching the official UI - a **Session history** clock and a **New chat** bubble - and a chevron **show/hide toggle** (`showSessionBar`, persisted to `argus.showSessionBar`). In show mode (`.topRightActionsFull`) the cluster stretches into a flat full-width header flush to the top/side edges (only a bottom border, `height: 30px` to match the log panel toolbar exactly), session name on the left and buttons pushed to the right via `margin-right: auto`; `.chatPane.sessionBarExpanded` gets `padding-top` so the first message isn't hidden behind the absolutely-positioned header. In hide mode it collapses to a small translucent corner tab (rounded bottom-left, `color-mix` background). New chat posts `newSession`; the server handler (`session.ts`) now does a full fresh start (detach+`killProc`, reset `sessionId`/bg counters/`lastMessage`, send `clear`) so every `newSession` caller (this button, the error-block "New session" button, the `argus.newSession` command) wipes the UI and abandons the current turn identically to `/clear`; e2e tests in `e2e/new-chat.spec.ts` (mock) and `e2e/new-chat-integration.spec.ts` (integration, asserts a reset session has no memory of an earlier token)
- Session history: the top-right history clock button (see Top-right header actions) opens `SessionHistoryModal` (centered `createPortal` modal, search box, local sessions only). The CLI persists each conversation as `~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl`, where the cwd is encoded by replacing every non-alphanumeric char with `-` (e.g. `d:\_Projects\argus` -> `d---Projects-argus`, no separator collapsing); `src/backend/sessions.ts` resolves that folder (tolerating drive-letter case via a case-insensitive `readdir` fallback). `listSessions(workspaceDir)` scans each `*.jsonl` for the latest title (a user-set `custom-title` takes precedence over the AI-generated `ai-title`, matching the official client) and `last-prompt` (subtitle), sorts by `mtime` desc, returns `{ id, title, lastPrompt, updatedAt }[]`; the WS reply `sessionList` also carries `currentId` (the live `s.sessionId`) so the modal highlights the active row with a green background (`.rowCurrent`, `--user-msg-bg`; no "current" text badge). `loadSession(id, workspaceDir)` replays the transcript into webview `UIMessage[]`: consecutive `assistant` lines merge into one message (interleaved `thinking`/`text`/`tool_use` blocks) until the next real user input; `tool_result` blocks attach to their `tool_use` by id; pure-`tool_result` user lines do not create user bubbles; user `image` blocks are preserved. `resumeSession {id}` (session.ts `handleResumeSession`) detaches+kills `currentProc` (so its close handler stays quiet, like `/clear`), sets `s.sessionId = id` (next send spawns with `--resume`), and emits `sessionLoaded {id, messages}`; the reducer's `sessionLoaded` action replaces `messages` and clears streaming/context state. `deleteSession {id}` removes the `.jsonl` (and sibling data folder) then re-sends `sessionList`; the modal also removes the row optimistically. `renameSession {id, title}` (sessions.ts `renameSession`) **appends** a fresh `{type:'custom-title', customTitle, sessionId}` line to the transcript (matching the official client's manual-rename format, so renames sync both ways; no full rewrite; `readSessionMeta` keeps the last `custom-title`, which outranks `ai-title`, so the appended line wins on the next `listSessions`), title is newline-stripped and capped at 200 chars, then re-sends `sessionList`; each row has a hover-reveal pencil (edit) button beside the trash button (both absolutely positioned at the right edge, replacing the time on hover) that opens an inline `<input>` (`.renameInput`) prefilled with the title - Enter/blur commits (optimistic local update + WS send), Escape cancels without closing the modal (the modal's `useEscapeKey` no-ops while `editingId` is set). The modal header has a refresh icon (Feather refresh-cw) beside the close button that re-sends `listSessions` and spins (`.refreshing`) until the next `sessionList` reply lands. Security: all four validate `id` against a UUID regex and assert the resolved path stays directly inside the project dir (no traversal). New WS messages route over the WS bridge (not `VS_ONLY`), so `chat.html`/`ChatPanel` need no change. e2e tests in `e2e/session-history.spec.ts` (mock) and `e2e/session-history-integration.spec.ts` (integration)
- Workspace history / switcher: the header workspace tile (`WorkspaceMenu.tsx`, `button` labelled "Switch workspace", shows the cwd basename) opens `WorkspaceHistoryModal` (centered `createPortal` modal) with two tabs. **Recent** tab: `listWorkspaces()` in `src/backend/sessions.ts` enumerates the projects the CLI has run in by scanning `~/.claude/projects/*/` and recovering each real cwd from the `cwd` field inside the transcript records (the folder name is a lossy encoding and can't be decoded), drops paths that no longer exist, sorts by latest transcript mtime, returns `{ path, name, sessions, updatedAt }[]`; the WS reply `workspaceList` carries `currentPath` so the active row is highlighted (`.rowCurrent`); a refresh icon re-scans. **Browse** tab: a real folder explorer over the whole machine backed by `listDir(target?)` (`sessions.ts`) -> WS reply `dirList {path, parent, entries}`; undefined target opens at `os.homedir()`, the empty-string sentinel (`DRIVES_ROOT = ''`) lists drive roots ("This PC" - `C:\`, `D:\`, … on win32, `/` on POSIX), and a filesystem root reports the drives root as its `parent` so the user can walk up past a drive to switch drives; directories only, sorted case-insensitively, tolerates unreadable dirs (empty list, still navigable up); the breadcrumb shows the current path (tail-truncated via `direction: rtl`), clicking a folder row navigates in, an "Up" row goes to `parent` (the up affordance is an arrow-up SVG, not a ".." label), and "Open this folder" picks the current dir (disabled at "This PC"). The breadcrumb is also **editable**: clicking it swaps the display `div` for an `input` (aria-label "Folder path") prefilled with the current path, so a folder path can be typed or pasted from the clipboard; Enter navigates there (`browseTo`), Escape/blur cancels (Escape first cancels the edit, then closes the modal via the guarded `useEscapeKey`), and the `dirList` reply clears the edit state. A bad path is auto-corrected server-side: `listDir` runs the resolved target through `nearestExistingDir()`, which walks up ancestors to the closest real directory (`C:\Users\Admi2` -> `C:\Users`, a file -> its dir, a missing drive -> `os.homedir()`), so the explorer never dead-ends on a typo. The modal is fixed at full height (`height: calc(100vh - 64px)`) with a `flex: 1` scrolling `.body`. Either tab's selection calls `onSelect(path)` -> `switchWorkspace` (App.tsx) which resets the UI and reconnects the WS with the new `?dir=` (handled in `index.html`/`chat.html`, not `VS_ONLY`). New WS messages (`listWorkspaces`/`workspaceList`, `listDir`/`dirList`) route over the WS bridge, so `chat.html`/`ChatPanel` need no change. e2e: `e2e/workspace-name-integration.spec.ts` (tile name), `e2e/workspace-browse-integration.spec.ts` (Browse folder explorer), and `e2e/workspace-browse-edit-integration.spec.ts` (editable breadcrumb: valid path navigates, invalid path falls back to nearest existing dir)
- Session architecture: `session.ts` is the thin orchestrator (WS message routing, send/stop logic); shared mutable state defined in `sessionState.ts` (`SessionState` interface + `createSessionState` factory); CLI stdout event parsing and proc lifecycle in `cliHandler.ts` (`handleCliEvent` dispatches by event type to focused handler functions: `handleSystemEvent`, `handleDelta`, `handleAssistant`, `handleToolResult`, `handleUserEvent`, `handleResult`); watchdog and login extracted as standalone modules returning handler objects; all modules receive `SessionState` reference for shared access
- Config cache: `readConfig()` uses `fs.statSync` mtime check; re-reads file only when mtime changes; external edits to `~/.claude/argus.json` take effect without server restart
- File path linkification: `linkifyPaths()` in `utils/filePath.tsx` skips strings longer than 5000 chars (`MAX_LINKIFY_LENGTH`) to prevent regex backtracking on adversarial LLM output
- E2e tests: Playwright-based, split into two projects in `playwright.config.ts`; `mock` project matches files without `-integration` suffix, runs first with 4 workers using `window.dispatchEvent` to inject messages, no Claude CLI needed; `integration` project matches `*-integration.spec.ts` files (regex `/-integration\.spec/`), runs after mock finishes (`dependencies: ['mock']`) to avoid OOM from concurrent CLI processes + Chromium instances; naming convention: integration tests must have `-integration` suffix (e.g. `chat-integration.spec.ts`), mock tests must not; `waitForApp()` in `e2e/helpers.ts` navigates with `waitUntil: 'domcontentloaded'` and retries `page.reload()` up to 3 times if React fails to mount; Chromium launched with `--disable-gpu --disable-dev-shm-usage --no-sandbox` for reduced memory; `retries: 1` for transient failures; `fullyParallel: true` for maximum parallelism within each project; `clickAndWaitForModal()` in file-path-links uses `toPass()` retry loop for WS roundtrip tolerance; the `test:e2e`, `test:e2e:integration`, and `test:e2e:headed` scripts prepend `node scripts/dev-stop.js &&` so any stale dev server (ports 5173/3001) is killed before Playwright starts a fresh one (`dev-stop.js` exits 0 when nothing is running, so the chain always proceeds); interactive scripts (`test:e2e:ui`, `test:e2e:debug`) and `test:e2e:report` are intentionally left without the prefix

## Skills

| Skill | Path | When to use |
|-------|------|-------------|
| frontend | `.claude/skills/frontend/SKILL.md` | Building or reviewing webview UI, React components, CSS styling |

## Slash Commands

| Command | Description |
|---------|-------------|
| `/bump` | Bump package.json version (patch/minor/major) |
| `/dev` | Control dev environment (start/stop/restart/status) |
| `/e2e` | Run Playwright e2e tests (all/mock/integration/specific file) |

## Development

```sh
yarn dev          # starts Vite frontend (port 5173) + WebSocket server (port 3001) in parallel
yarn dev:frontend # Vite dev server only (no backend)
yarn dev:server   # WebSocket server only (tsx server/index.ts)
yarn build        # bundle React webview to media/webview.js + media/webview.css
yarn watch        # watch + rebuild webview on save (for VS Code Extension Host testing)
yarn compile      # compile extension TypeScript
yarn watch:tsc    # watch mode for extension TypeScript
yarn test:e2e     # run Playwright e2e tests (starts dev server automatically)
yarn test:e2e:integration # run only integration tests (skips mock dependency)
yarn test:e2e:headed # run e2e tests with visible browser
yarn test:e2e:ui  # open Playwright UI mode
yarn ctx:install  # add "Open Argus" to Windows Explorer context menu (requires elevated shell)
yarn ctx:uninstall # remove context menu entry
# Primary UI testing: use `yarn dev` + browser refresh - do not suggest reloading VS Code extension
# Press F5 in VS Code to launch Extension Development Host (for extension-side code only)
```

## Commands

| Command | Keybinding | Description |
|---------|-----------|-------------|
| argus.openChat | Ctrl+Shift+A | Open chat panel |
| argus.askSelection | Ctrl+Shift+Q | Ask about selected code |
| argus.editSelection | - | Edit selected code with AI |
| argus.reviewSelection | - | Code review of selection |
| argus.newSession | - | Start fresh conversation |

## Settings

| Setting | Default | Description |
|---------|---------|-------------|
| argus.model | _(CLI default)_ | Model to use (free-text; any CLI-supported name) |
| argus.inlineCompletions.enabled | false | Enable inline completions |
| argus.codeLens.enabled | true | Show code lens |
| argus.bash.useIntegratedTerminal | true | Run bash in terminal |
| argus.inlineCompletions.model | claude-haiku-4-5 | Model for inline completions |

## Optimizations

See [docs/optimizations.md](docs/optimizations.md) for performance work (persistent CLI process in both `server/index.ts` and `src/agent/AgentSession.ts`, future prespawn idea, benchmarks).

## Research

- [.claude/researches/playwright-install-hang.md](.claude/researches/playwright-install-hang.md) - `yarn test:e2e:install` hangs on Windows: Playwright's bundled extractor deadlocks unzipping browser binaries (Defender locks `D3DCompiler_47.dll` mid-scan). Fix: manually download + `Expand-Archive` all four components (chromium, headless-shell, ffmpeg, winldd) and write `INSTALLATION_COMPLETE` markers.
