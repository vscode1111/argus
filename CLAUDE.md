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
media/
  chat.html             - Webview HTML template (React mount point, placeholders injected by ChatPanel)
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
    dev/
      DevHarness.tsx    - Fixed bottom toolbar, fires mock extension messages for browser testing
    utils/
      markdown.tsx      - react-markdown wrapper with VS Code CSS variable styling
      time.ts           - formatDuration helper
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
- Webview message protocol (extension -> webview): typed as `WebviewMessage` union in `ChatPanel.ts` - `thinking_start | thinking_chunk | text_chunk | tool_start | tool_end | done | error | message | clear | prefill | skills | workspaceInfo | log | clearLogs | loginUrl | loginResult`
- Webview message protocol (webview -> extension): `send | stop | forceError | newSession | openFile | openUrl | getInfo | getSkills | retry | login | loginCode`
- Modal Escape handling: use `useEscapeKey(onClose)` hook from `hooks/useEscapeKey.ts` - do not duplicate keydown listeners
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
- AskUserQuestion: rendered as a card with header, question text, and radio-button options; selected answer highlighted from parsed JSON result; styles in `ToolCall.module.css`

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
# Press F5 in VS Code to launch Extension Development Host
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
