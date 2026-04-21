# Argus - VS Code Extension

AI coding assistant powered by Claude, built as a VS Code extension.

## Project Structure

```
src/
  extension.ts          - Activation entry point, registers commands/providers
  agent/
    ClaudeClient.ts     - Anthropic SDK wrapper, streaming + tool use
    AgentLoop.ts        - Agentic loop orchestrating tools and conversation
    tools/              - Individual tool implementations (read, write, edit, glob, grep, bash)
  chat/
    ChatPanel.ts        - WebviewPanel lifecycle and message handling
    ChatMessage.ts      - Message types
  providers/
    InlineSuggestProvider.ts  - Inline completions (Copilot-style)
    CodeLensProvider.ts       - "Ask Argus" code lens
  utils/
    config.ts           - Extension settings helpers
    workspace.ts        - VS Code workspace helpers
cmd/
  start-argus.bat       - Launch dev server (double-click from Explorer)
  ctx-install.bat       - Install context menu entry (run as admin)
  ctx-uninstall.bat     - Remove context menu entry (run as admin)
scripts/
  context-menu.js       - Cross-platform context menu install/uninstall (Windows registry / Linux .desktop entry)
  launch.js             - Opens Chrome in app mode with optional ?dir= param (cross-platform Chrome paths)
  launch.vbs            - Windows-only VBS wrapper for windowless launch (invoked by context menu registry)
media/
  chat.html             - Webview HTML template (React mount point, placeholders injected by ChatPanel)
  argus-icon.ico        - App icon for context menu and favicon
  webview.js            - Bundled React app (gitignored, run `yarn build` to generate)
  webview.css           - Bundled styles (gitignored, run `yarn build` to generate)
webview/
  vite.config.ts        - Vite lib-mode build config (IIFE, outputs to media/)
  vite.dev.config.ts    - Vite dev server config (port 5173, HMR)
  tsconfig.json         - TypeScript config for webview (JSX, ESNext)
  index.html            - Dev entry point with VS Code variable mocks (Dark+ theme)
  src/
    index.tsx           - React entry point (production)
    index.dev.tsx       - React entry point (dev, mounts App + DevHarness)
    App.tsx             - Root component, useReducer state, VS Code message listener
    types.ts            - Shared types (UIMessage, StreamingState, ToolCallData, ContentBlock, ErrorKind, LoginState)
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
      SettingsModal.tsx / .module.css
      InputArea.tsx / .module.css
    hooks/
      useEscapeKey.ts   - Shared hook for Escape-to-close on modals
      useEncoding.ts    - Shared hook for encoding state + memoized decode
    dev/
      DevHarness.tsx    - Fixed bottom toolbar, fires mock extension messages for browser testing
    utils/
      markdown.tsx      - react-markdown wrapper with VS Code CSS variable styling
      time.ts           - formatDuration helper
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
- Webview message protocol (extension -> webview): typed as `WebviewMessage` union in `ChatPanel.ts` - `thinking_start | thinking_chunk | text_chunk | tool_start | tool_end | done | error | message | clear | prefill | skills | workspaceInfo | log | clearLogs | loginUrl | loginResult | contextUsage`
- Webview message protocol (webview -> extension): `send | stop | forceError | newSession | openFile | openUrl | getInfo | getSkills | retry | toolAnswer | login | loginCode`
- Modal Escape handling: use `useEscapeKey(onClose)` hook from `hooks/useEscapeKey.ts` - do not duplicate keydown listeners
- Modal portals: FileViewerModal, DiffViewerModal, and ImageViewerModal use `createPortal(jsx, document.body)` to render outside the React tree, avoiding z-index stacking issues when modals are opened from inside the scrollable MessageList during streaming
- Errors use `showError()` helper in ChatPanel - shows VS Code error notification with "View Output" action
- AgentSession and ChatPanel use a shared `vscode.OutputChannel` ("Argus") for stderr and error logging
- Image paste: clipboard images are base64-encoded in the webview, sent via `--input-format stream-json` NDJSON to the Claude CLI with `type: "image"` content blocks
- Slash commands: InputArea shows a dropdown when "/" is typed; sends `getSkills` to extension, receives `skills` response with `{ name, scope: 'builtin' | 'global' | 'project' }[]`; skills read from `~/.claude/skills/` (global) and `<workspace>/.claude/skills/` (project); built-in commands hardcoded in `ChatPanel.getSkills()` and `vite.dev.config.ts`; Tab or Enter selects highlighted skill
- Log panel: has its own settings dropdown (gear icon) with toggles for show time / show type; settings persisted via `SettingsContext` to localStorage (`argus.showLogTime`, `argus.showLogType`)
- Error handling: errors classified into `ErrorKind` (`auth | not_found | session | generic`) via `classifyError()` in `AgentSession.ts`; webview shows structured error blocks with contextual actions (Login, Retry, New session)
- Login flow: `AgentSession.startLogin()` spawns `claude auth login`, captures OAuth URL, accepts auth code via stdin; webview `LoginPanel` in `ChatMessage.tsx` manages the UI; `LoginState` tracks phases (`idle | starting | url | submitting | success | error`)
- Retry: ChatPanel stores last user text/images; webview sends `retry` message to re-run the last prompt
- Sound on complete: `playCompletionSound()` in `App.tsx` via AudioContext; toggled by `soundOnComplete` setting in `SettingsContext`
- Global scrollbar styling: thin scrollbars via `scrollbar-width: thin` and `::-webkit-scrollbar` rules in `global.css`
- Content blocks: streaming and completed messages use `ContentBlock[]` (interleaved `{ type: 'text' }` and `{ type: 'tool' }` blocks) instead of separate text/toolCalls fields - preserves tool-call ordering relative to text
- AskUserQuestion: tabbed dialog UI - multiple questions shown as tabs, supports single-select (radio dots) and multi-select (checkboxes via `multiSelect` flag), includes automatic "Other" option with free-text input (injected client-side in ToolCall.tsx); text blocks after a pending AskUserQuestion are hidden so the AI appears to wait; cancelled dialogs show "Session ended"; completed answers show a result summary strip (`askResultSummary`); `tool_end` events can update completed messages (not just streaming) for late answers; `AskUserQuestion` blocked in plan mode. Answers sent back to CLI via `AgentSession.sendToolResult()` - stdin kept open until all interactive tools resolve; `pendingToolResolvers` map tracks in-flight prompts and are resolved with `{ cancelled: true }` on stop/close; `skipNextToolEnd` prevents duplicate tool_end events
- Pending tool animation: tool names pulse (green, `toolNamePending` class) while awaiting result; `pending` flag derived from `!result && !error`
- Directory-aware launch: context menu passes `?dir=` query param to the dev URL; `index.html` forwards it to the WebSocket (`ws://localhost:5173/agent?dir=...`); `vite.dev.config.ts` reads `dir` from the upgrade request and uses it as `cwd` for Claude CLI spawns and skill discovery; `App.tsx` dispatches `workspaceInfo` on mount if `dir` is present
- Context usage indicator: pill in InputArea (`contextPill`) shows "X% used" of 200k context window; extracted from CLI `assistant` event's `message.usage` (sums `input_tokens + cache_read_input_tokens + cache_creation_input_tokens + output_tokens`); color-coded: default <50%, yellow (`contextMedium`) 50-80%, red (`contextHigh`) 80%+; tooltip shows token breakdown; persists across messages (instance-scoped counters in ChatPanel), resets on clear/new session; ignores synthetic events (zero usage) from slash commands like `/context`

## Skills

| Skill | Path | When to use |
|-------|------|-------------|
| frontend | `.claude/skills/frontend/SKILL.md` | Building or reviewing webview UI, React components, CSS styling |

## Development

```sh
yarn dev          # browser dev server at http://localhost:5173 (HMR, DevHarness mock panel)
yarn build        # bundle React webview to media/webview.js + media/webview.css
yarn watch        # watch + rebuild webview on save (for VS Code Extension Host testing)
yarn compile      # compile extension TypeScript
yarn watch:tsc    # watch mode for extension TypeScript
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
