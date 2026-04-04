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
  webview.js            - Bundled React app (output of `npm run build:webview`, do not edit)
  webview.css           - Bundled styles (output of `npm run build:webview`, do not edit)
webview/
  vite.config.ts        - Vite lib-mode build config (IIFE, outputs to media/)
  vite.dev.config.ts    - Vite dev server config (port 5173, HMR)
  tsconfig.json         - TypeScript config for webview (JSX, ESNext)
  index.html            - Dev entry point with VS Code variable mocks (Dark+ theme)
  src/
    index.tsx           - React entry point (production)
    index.dev.tsx       - React entry point (dev, mounts App + DevHarness)
    App.tsx             - Root component, useReducer state, VS Code message listener
    types.ts            - Shared types (UIMessage, StreamingState, ToolCallData)
    vscode.ts           - acquireVsCodeApi() singleton + postMessage helper
    components/
      Header.tsx        - Title + new session button
      MessageList.tsx   - Scrollable messages, auto-scroll
      ChatMessage.tsx   - Finalized user/assistant/error message
      StreamingMessage.tsx - Live streaming message with cursor
      StreamingTimer.tsx   - Live elapsed time during streaming
      ThinkingBlock.tsx    - Collapsible thinking block
      ToolCall.tsx         - Tool call visualization (verbose/compact)
      InputArea.tsx        - Textarea + send/stop/kill, input history
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
- Webview UI is React 18 + TypeScript + Vite (lib/IIFE mode). Build with `npm run build:webview`
- Webview styling uses VS Code CSS variables (`var(--vscode-*)`) - no Tailwind, auto-adapts to any theme
- Webview markdown rendered via `react-markdown` in `utils/markdown.tsx`
- Webview message protocol (extension -> webview): `thinking_start | thinking_chunk | text_chunk | tool_start | tool_end | done | error | message | clear | prefill`
- Errors use `showError()` helper in ChatPanel - shows VS Code error notification with "View Output" action
- AgentSession and ChatPanel use a shared `vscode.OutputChannel` ("Argus") for stderr and error logging

## Skills

| Skill | Path | When to use |
|-------|------|-------------|
| frontend | `.claude/skills/frontend/SKILL.md` | Building or reviewing webview UI, React components, CSS styling |

## Development

```sh
yarn dev:webview     # browser dev server at http://localhost:5173 (HMR, DevHarness mock panel)
yarn build:webview   # bundle React webview to media/webview.js + media/webview.css
yarn watch:webview   # watch + rebuild webview on save (for VS Code Extension Host testing)
yarn compile         # compile extension TypeScript
yarn watch           # watch mode for extension TypeScript
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
