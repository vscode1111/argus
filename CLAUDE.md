# Argus - VS Code Extension

AI coding assistant powered by Claude, built as a VS Code extension.

## Project Structure

```
src/
  extension.ts          - Activation entry point, starts WS server on dynamic port, registers commands/providers
  argusServer.ts        - Shared WebSocket server (Claude CLI orchestration, used by both extension and standalone)
  chat/
    ChatPanel.ts        - WebviewPanel lifecycle, VS Code-specific message handlers, injects WS URL into HTML
    ChatMessage.ts      - Message types
  providers/
    InlineSuggestProvider.ts  - Inline completions (Copilot-style)
    CodeLensProvider.ts       - "Ask Argus" code lens
  utils/
    config.ts           - Extension settings helpers
    workspace.ts        - VS Code workspace helpers
    win32Focus.ts       - Win32 FFI (koffi) for reliable SetForegroundWindow on notification click
cmd/
  start-argus.bat       - Launch dev server (double-click from Explorer)
  ctx-install.bat       - Install context menu entry (run as admin)
  ctx-uninstall.bat     - Remove context menu entry (run as admin)
  kill-claude.bat       - Kill all running Claude Code processes
server/
  index.ts              - Thin entry point for standalone dev mode (imports startServer from src/argusServer.ts)
  tsconfig.json         - TypeScript config for server
scripts/
  dev.js                - Orchestrates Vite frontend + WebSocket server in parallel (colored [fe]/[be] output, watches server/ and src/argusServer.ts)
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
  chat.spec.ts          - Integration: send message, verify logs and response
  ask-dialog.spec.ts    - Integration: AskUserQuestion dialog interaction
  ask-dialog-resume.spec.ts - Mock: AskUserQuestion answer commit, follow-up, cancel
  image-recognize.spec.ts - Integration: paste image, verify text recognition
  slash-commands.spec.ts - Mock: slash command menu UI (filtering, scopes, keyboard nav)
  slash-commands-integration.spec.ts - Integration: real commands/skills from server
  stop-no-error.spec.ts - Mock: stop does not produce error blocks
  background-tasks.spec.ts - Mock: background task indicators and counters
  retry-clean.spec.ts   - Mock: retry cleanup of error messages
  retry-indicator.spec.ts - Mock: retry status indicator display
  file-path-links.spec.ts - Mock + WS: file path rendering and FileViewerModal
webview/
  vite.config.ts        - Vite lib-mode build config (IIFE, outputs to media/)
  vite.dev.config.ts    - Vite dev server config (port 5173, HMR)
  tsconfig.json         - TypeScript config for webview (JSX, ESNext)
  index.html            - Dev entry point with VS Code variable mocks (Dark+ theme)
  src/
    index.tsx           - React entry point (production)
    index.dev.tsx       - React entry point (dev, mounts App + DevHarness)
    App.tsx             - Root component, useReducer state, VS Code message listener
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
      FileViewerModal.tsx / .module.css  - Uses shared/modal.module.css
      DiffViewerModal.tsx / .module.css  - Uses shared/modal.module.css
      ImageViewerModal.tsx / .module.css
      InfoModal.tsx / .module.css
      SettingsModal.tsx / .module.css  - Centered modal with tabs (General/Watchdog/Info), includes NumberInput component
      InputArea.tsx / .module.css
    hooks/
      useEscapeKey.ts   - Shared hook for Escape-to-close on modals
      useEncoding.ts    - Shared hook for encoding state + memoized decode
    dev/
      DevHarness.tsx    - Fixed bottom toolbar, fires mock extension messages for browser testing
    utils/
      markdown.tsx      - react-markdown wrapper with VS Code CSS variable styling
      filePath.tsx      - Clickable file path detection and linkification (FilePathLink + linkifyPaths + withLinkedPaths)
      time.ts           - formatDuration and formatTime helpers
      encoding.ts       - ENCODINGS list and tryDecode() for charset re-interpretation
```

## Key Conventions

- Model: `claude-opus-4-6` for agent (adaptive thinking), `claude-haiku-4-5` for inline completions
- Streaming: always use `client.messages.stream()` + `finalMessage()`
- Tool approval: destructive tools (write_file, bash) require user confirmation via `showWarningMessage`
- No Python scripts - use Node.js/TypeScript for any tooling
- Webview UI is React 18 + TypeScript + Vite (lib/IIFE mode). Build with `yarn build`
- Webview styling uses CSS Modules (co-located `.module.css` files) with VS Code CSS variables (`var(--vscode-*)`) - no Tailwind, auto-adapts to any theme
- CSS Modules: camelCase class names for dot access (`styles.toolCall`), conditional classes via `.filter(Boolean).join(' ')`, shared modules in `components/shared/`, `composes:` for reuse
- CSS color tokens: diff/semantic colors defined as CSS variables in `global.css` (`--diff-added`, `--diff-removed`, `--user-msg-bg`, etc.) - never hardcode color literals in component CSS
- Webview markdown rendered via `react-markdown` in `utils/markdown.tsx`
- Webview message protocol (extension -> webview): typed as `WebviewMessage` union in `ChatPanel.ts` - `thinking_start | thinking_chunk | text_chunk | tool_start | tool_end | done | error | message | clear | prefill | skills | workspaceInfo | log | clearLogs | loginUrl | loginResult | contextUsage | filePreview | retry_status | retry_clean`
- Webview message protocol (webview -> extension): `send | stop | forceError | newSession | openFile | openUrl | getInfo | getSkills | retry | toolAnswer | login | loginCode | focusPanel | readFilePreview`
- Modal Escape handling: use `useEscapeKey(onClose)` hook from `hooks/useEscapeKey.ts` - do not duplicate keydown listeners
- Modal portals: FileViewerModal, DiffViewerModal, and ImageViewerModal use `createPortal(jsx, document.body)` to render outside the React tree, avoiding z-index stacking issues when modals are opened from inside the scrollable MessageList during streaming
- Errors use `showError()` helper in ChatPanel - shows VS Code error notification with "View Output" action
- AgentSession and ChatPanel use a shared `vscode.OutputChannel` ("Argus") for stderr and error logging
- Image paste: clipboard images are base64-encoded in the webview, sent via `--input-format stream-json` NDJSON to the Claude CLI with `type: "image"` content blocks
- Slash commands: InputArea shows a dropdown when "/" is typed; sends `getSkills` to extension, receives `skills` response with `{ name, scope: 'builtin' | 'global' | 'project', description? }[]`; commands read from `~/.claude/commands/` (global) and `<workspace>/.claude/commands/` (project) as `.md` files with YAML frontmatter `description:` field; skills read from `~/.claude/skills/` (global) and `<workspace>/.claude/skills/` (project) via `SKILL.md` frontmatter; built-in commands hardcoded in `argusServer.ts`; `readCommandsDir` parses frontmatter for description, falls back to first non-frontmatter line; Tab or Enter selects highlighted skill; description truncated to 100 chars in dropdown; e2e tests in `e2e/slash-commands.spec.ts` (mock) and `e2e/slash-commands-integration.spec.ts` (integration)
- Log panel: has its own settings dropdown (gear icon) with toggles for show time / show type; settings persisted via `SettingsContext` to localStorage (`argus.showLogTime`, `argus.showLogType`); log text is color-highlighted by content: "Spawning claude" entries render green (`textSpawn`), "exited with code" entries render orange (`textExit`)
- Error handling: errors classified into `ErrorKind` (`auth | not_found | session | generic`) via `classifyError()` in `argusServer.ts`; webview shows structured error blocks with contextual actions (Login, Retry, New session); API errors delivered as text content (e.g. "API Error: 403") are detected via a 3-second stale timer in the server and converted to error+done events; if `error` arrives after `done`, the reducer retroactively marks the last assistant message's outcome as `'error'`
- Login flow: `AgentSession.startLogin()` spawns `claude auth login`, captures OAuth URL, accepts auth code via stdin; webview `LoginPanel` in `ChatMessage.tsx` manages the UI; `LoginState` tracks phases (`idle | starting | url | submitting | success | error`)
- Retry: server stores `lastMessage`; webview sends `retry` message; server sends `retry_clean` (reducer removes trailing error-role messages and re-marks error-outcome assistant messages as `retried` to preserve content history) then re-emits as `send` with `_silent: true` (no duplicate user message); `thinking_start` is always sent regardless of `_silent` so streaming state initializes; retried messages show a compact yellow timer with "reconnected Nx" text instead of the full error block; e2e tests in `e2e/retry-clean.spec.ts`
- Sound on complete: `playCompletionSound()` in `App.tsx` via AudioContext; toggled by `soundOnComplete` setting in `SettingsContext`; suppressed when user manually stops the session (`outcome === 'stopped'`)
- Notify on complete: browser `Notification` API fires when streaming finishes (if `notifyOnComplete` enabled in `SettingsContext`); requests permission on first enable; notification title includes project name, body shows last user message; clicking focuses the window; suppressed on manual stop
- Copy buttons: user messages have a hover-reveal copy button (`MessageCopyButton` in `ChatMessage.tsx`); code blocks have a hover-reveal copy button (`CopyButton` in `utils/markdown.tsx`) styled via `global.css` (`.code-block-wrapper` / `.code-copy-btn`)
- SettingsModal: fixed centered modal with 3 tabs (General, Watchdog, Info); selected tab persisted to localStorage (`argus.settingsTab`); General tab has toggles for verbose tools, show timer, show output, show logs, sound/notify on complete; Watchdog tab has enabled toggle + NumberInput fields for timeout, auto retries, base delay, delay factor (disabled when watchdog off); Info tab shows version and workspace path (replaced standalone InfoModal); all setting labels have `title` tooltips; `NumberInput` component uses local string state for editing UX, allows empty field while focused, falls back to `min` value on blur; on mount, sends `getSettings` to re-fetch current server config (prevents stale cached values)
- Dev harness toggle: SettingsModal "dev" button dispatches `devharness-toggle` custom event; DevHarness listens and toggles its own `visible` state (returns `null` when hidden); available in both browser dev and VS Code extension mode (`#dev-harness` div in both `index.html` and `chat.html`); state persisted to localStorage (`argus.showDevHarness`); `body.dev-harness-visible` class controls bottom padding
- Editor title icon: `argus.openChat` command registered in `editor/title` menu group with `media/argus-icon.svg` icon
- Global scrollbar styling: thin scrollbars via `scrollbar-width: thin` and `::-webkit-scrollbar` rules in `global.css`
- Content blocks: streaming and completed messages use `ContentBlock[]` (interleaved `{ type: 'text' }` and `{ type: 'tool' }` blocks) instead of separate text/toolCalls fields - preserves tool-call ordering relative to text
- AskUserQuestion: tabbed dialog UI (`askDialog`, `width: fit-content`) - multiple questions shown as tabs, supports single-select (radio dots) and multi-select (checkboxes via `multiSelect` flag), includes automatic "Other" option with free-text input (injected client-side in ToolCall.tsx); full-width submit button; text blocks after a pending AskUserQuestion are hidden so the AI appears to wait; cancelled dialogs show "Session ended"; completed answers show a result summary strip (`askResultSummary`); `tool_end` events can update completed messages (not just streaming) for late answers; `AskUserQuestion` blocked in plan mode. Answers sent back to CLI via `AgentSession.sendToolResult()` - stdin kept open until all interactive tools resolve; `pendingToolResolvers` map tracks in-flight prompts and are resolved with `{ cancelled: true }` on stop/close; `skipNextToolEnd` prevents duplicate tool_end events
- Pending tool animation: tool names pulse (green, `toolNamePending` class) while awaiting result; `pending` flag derived from `!result && !error`; on `done` or `error`, any still-pending tool blocks are marked `error: true` so they stop pulsing
- Clickable file paths: `utils/filePath.tsx` detects absolute paths (Windows and Unix) with optional `:line` or `:line-endLine` suffix in user messages and markdown output; `linkifyPaths()` for plain text, `withLinkedPaths()` for React children (recursively walks into nested elements like `<strong>`, `<code>`, `<td>`); clicking opens `FileViewerModal`; `readFilePreview` / `filePreview` message pair fetches file content from extension; `openFile` supports `line` parameter to jump to a specific line; styled via `.file-path-link` in `global.css`; `protectPathBackslashes()` in `markdown.tsx` escapes Windows backslashes before markdown parsing; `FileViewerModal` scrolls to the target line and highlights the range with `--diff-added-bg`; SyntaxHighlighter uses `transparent` background (inherits from modal); e2e tests in `e2e/file-path-links.spec.ts`
- Dev theme: `webview/index.html` uses Dark 2026 theme variables (extracted from VS Code state DB) to match the user's VS Code appearance in browser dev mode
- Log panel close: LogPanel has a close button (X) that calls `onClose` prop, which toggles `showLogs` off via `setShowLogs(false)` in App
- Multi-panel support: `ChatPanel` tracks all open panels in a static `Set<ChatPanel>` with a `lastFocused` pointer; `createNew()` always opens a fresh panel, `focusOrCreate()` reveals the last-focused one; `argus.openChat` creates new panels, other commands reuse the last-focused panel
- Win32 focus: `win32Focus.ts` uses `koffi` FFI to call `SetForegroundWindow`/`BringWindowToTop`; `captureForegroundWindow()` is called on panel creation, `focusCachedWindow()` on notification click via the `focusPanel` webview message
- Unified WebSocket server: `src/argusServer.ts` exports `startServer({ port, model })` used by both the VS Code extension (dynamic port via `port: 0`) and standalone dev mode (`server/index.ts`, port 3001); the extension starts the server on `activate()` and shuts it down on `deactivate()`; `ChatPanel` injects the WS URL (`ws://localhost:PORT/agent?dir=...`) into `chat.html`; the webview connects via a shim script that routes Claude-related messages to WS and VS Code-specific messages (`openFile`, `openUrl`, `focusPanel`, `getInfo`, `readFilePreview`) to real `postMessage`; one port serves many panels (per-connection isolated state); `scripts/dev.js` starts both Vite and server in parallel, watches `server/` and `src/argusServer.ts` for auto-restart
- Directory-aware launch: context menu passes `?dir=` query param to the dev URL; `index.html` forwards it to the WebSocket (`ws://localhost:3001/agent?dir=...`); server reads `dir` from the upgrade request and uses it as `cwd` for Claude CLI spawns and skill discovery; `App.tsx` dispatches `workspaceInfo` on mount if `dir` is present
- Response time and outcome: completed assistant messages store `responseTime` (ms), `finishedAt` (timestamp), and `outcome` (`'success' | 'stopped' | 'error' | 'retried'`); timer text is color-coded: green (`responseTimeSuccess`) for success, blue (`responseTimeStopped`, `--vscode-charts-blue`) for stopped, red (`responseTimeError`, `--vscode-errorForeground`) for error, yellow (`responseTimeRetried`, `--vscode-editorWarning-foreground`) for watchdog-retried; retried messages show compact timer with "reconnected Nx" suffix (always visible regardless of `showTimer` setting); finish time shown in brackets e.g. "8s (02:15:35)"; `StreamingTimer` shows elapsed+idle during streaming; `InputArea.onStop` dispatches `stop` action to set `streaming.stopped = true` before `done` commits the message
- Log panel performance: log entry text uses `max-height: 4.5em` + `overflow: hidden` to cap visual height; `.logPane` uses `contain: inline-size` to prevent content from affecting parent layout width during reflow (prevents layout glitch on VS Code tab switch); server truncates debug event logs to 120 chars; `word-break: break-word` instead of `break-all` for natural line breaks
- DiffViewerModal: side-by-side diff with `pairRows()` that groups consecutive removes/adds into paired `change` rows (no empty-cell gaps); `pre-wrap` + `word-break: break-word` for long lines; `1fr 1fr` grid without `max-content` so columns stay equal width
- Tool summary tooltips: `title` attribute on all `toolSummary` spans/links (file paths, Bash commands) so truncated text is visible on hover
- DevHarness stress test: "10K" button generates 10,000 log entries + 20 multi-tool assistant messages for layout/performance testing; "diff" button simulates two Edit tool calls (markdown + TypeScript refactor) for DiffViewerModal testing
- Context usage indicator: pill in InputArea (`contextPill`) shows "X%" of 200k context window (full "X% used" in tooltip); extracted from CLI `assistant` event's `message.usage` (sums `input_tokens + cache_read_input_tokens + cache_creation_input_tokens + output_tokens`); color-coded: default <50%, yellow (`contextMedium`) 50-80%, red (`contextHigh`) 80%+; tooltip shows token breakdown; persists across messages (instance-scoped counters in ChatPanel), resets on clear/new session; ignores synthetic events (zero usage) from slash commands like `/context`
- Watchdog: interval-based health check every 5s in `argusServer.ts`; compares elapsed time since last JSON event from CLI stdout (`lastEventTime`) against `watchdogTimeout` config (min 10s, default 120s); can be disabled via `watchdogEnabled` (default true); auto-retries up to `watchdogAutoRetries` (default 3) with configurable exponential backoff: `delay = watchdogRetryDelay * watchdogDelayFactor^attempt` (defaults: base 5s, factor 2, producing 5s/10s/20s); `watchdogRetrying` flag prevents the proc close handler from sending premature `done` during retry; on retry, `retry_status` handler commits current streaming blocks as a completed `retried` message (preserves progress history) then clears streaming for the new attempt; `thinking_start` inherits `retryStatus` and `watchdogRetries` from previous streaming so "Reconnecting (N/M)" indicator persists across attempts; each committed retried message shows a yellow timer with "reconnected Nx" text (always visible regardless of `showTimer` setting); when all retries exhausted, sends `retry_status` with `timedOut: true` + `done` to end the session; `cliDone = true` on timeout prevents late stdout events from creating phantom sessions; pending retry timers are cancelled on timeout; redundant "Something went wrong" error messages suppressed when watchdog block already present; server `stop` handler sends `done` directly when proc is already dead; `watchdogRetries` tracked in `StreamingState` and persisted to `UIMessage` for timer display; e2e tests in `e2e/retry-indicator.spec.ts`
- Background tasks: CLI `run_in_background: true` Bash tools produce `task_started`, `task_updated`, `task_notification` system events; server tracks pending tasks in `pendingBgTasks` Set and `totalBgTasks` counter (both reset at each user-initiated turn); `done` event includes `pendingBackgroundTasks` and `totalBackgroundTasks` when tasks are pending; reducer creates `background_waiting` outcome messages with `bgTasksCompleted`/`bgTasksTotal` on `UIMessage`; `WorkingIndicator` shows "Waiting background task" (singular, no counter) for 1 task, "Waiting background tasks (N/M)" for multiple, with live elapsed timer and idle time on a separate line; `task_notification` triggers a `tool_end` event with summary + output file content (`fs.readFileSync`) to update the original tool call result; `tool_end` reducer checks streaming blocks first, falls through to completed messages for late updates; Out link pulses green (`toolOutLinkRunning` class, reuses `toolPulse` animation) while result starts with "Command running in background", stops when result is updated or session ends; `sessionDone` prop passed from ChatMessage to ToolCall excludes `background_waiting` and `background_done` outcomes so Out links keep pulsing for still-running tasks; previous `background_waiting` messages are resolved to `background_done` (no indicator, no timer) when a new `done` arrives; e2e tests in `e2e/background-tasks.spec.ts`
- CLI stdin error handler: `proc.stdin.on('error', ...)` in `attachProcHandlers` prevents the server from crashing when the CLI process dies unexpectedly (e.g. Bun panic); without it, a `write EOF` error on stdin propagates as an unhandled event that kills the Node.js server and drops all WebSocket connections
- E2e tests: Playwright-based, split into two projects in `playwright.config.ts`; `mock` project (background-tasks, retry-clean, retry-indicator, file-path-links, ask-dialog-resume, stop-no-error, slash-commands) runs first with 4 workers using `window.dispatchEvent` to inject messages, no Claude CLI needed; `integration` project (chat, ask-dialog, image-recognize, slash-commands-integration) runs after mock finishes (`dependencies: ['mock']`) to avoid OOM from concurrent CLI processes + Chromium instances; `waitForApp()` in `e2e/helpers.ts` navigates with `waitUntil: 'domcontentloaded'` and retries `page.reload()` up to 3 times if React fails to mount; Chromium launched with `--disable-gpu --disable-dev-shm-usage --no-sandbox` for reduced memory; `retries: 1` for transient failures; `fullyParallel: true` for maximum parallelism within each project; `clickAndWaitForModal()` in file-path-links uses `toPass()` retry loop for WS roundtrip tolerance; new e2e test files must be added to either `mock` or `integration` testMatch regex in `playwright.config.ts`

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
yarn dev:server   # WebSocket server only (node --experimental-strip-types server/index.ts)
yarn build        # bundle React webview to media/webview.js + media/webview.css
yarn watch        # watch + rebuild webview on save (for VS Code Extension Host testing)
yarn compile      # compile extension TypeScript
yarn watch:tsc    # watch mode for extension TypeScript
yarn test:e2e     # run Playwright e2e tests (starts dev server automatically)
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
| argus.model | claude-opus-4-6 | Model to use |
| argus.inlineCompletions.enabled | false | Enable inline completions |
| argus.codeLens.enabled | true | Show code lens |
| argus.bash.useIntegratedTerminal | true | Run bash in terminal |
| argus.inlineCompletions.model | claude-haiku-4-5 | Model for inline completions |

## Optimizations

See [docs/optimizations.md](docs/optimizations.md) for performance work (persistent CLI process in both `server/index.ts` and `src/agent/AgentSession.ts`, future prespawn idea, benchmarks).
