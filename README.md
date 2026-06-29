# Argus

AI coding assistant for VS Code, powered by Claude.

## Requirements

- [Claude Code CLI](https://docs.anthropic.com/claude/docs/claude-code) installed and authenticated. Run `claude` once in a terminal to log in.
- VS Code 1.85 or newer.

## Commands

| Command | Shortcut | Description |
|---------|----------|-------------|
| Argus: Open Chat | `Ctrl+Shift+A` | Open a new chat panel |
| Argus: Ask About Selection | `Ctrl+Shift+Q` | Send the highlighted code to Argus with a question |
| Argus: Edit Selection with AI | - | Apply an AI edit to the selection |
| Argus: Review Selection | - | Run a code review on the selection |
| Argus: New Session | - | Start a fresh conversation |

## Features

- Streaming chat with Claude, including tool calls (read, write, edit, bash, grep, glob, web search, web fetch).
- Live token spending display: input and output token counts update in real time during streaming, shown in the message timer.
- Collapsible thinking blocks: extended thinking is shown collapsed with a token estimate; click to expand the full reasoning.
- Plan mode for dry-run exploration without file edits.
- Slash commands: built-in (`/compact`, `/model`, `/clear`, ...) and custom skills from `~/.claude/skills/` and `<workspace>/.claude/skills/`.
- Paste images directly into the input with `Ctrl+V`.
- Inline diff and file viewers next to tool calls.
- OS toast notifications on task completion (clickable to refocus VS Code).
- Optional "Ask Argus" code lens above functions and classes.
- Optional inline code completions (Haiku model, Copilot-style).

## Settings

| Setting | Default | Description |
|---------|---------|-------------|
| `argus.model` | _(CLI default)_ | Model used by the chat (any CLI-supported name; leave empty to use the CLI default) |
| `argus.inlineCompletions.enabled` | `false` | Enable inline code completions |
| `argus.inlineCompletions.debounceMs` | `500` | Debounce delay for inline completions |
| `argus.codeLens.enabled` | `true` | Show "Ask Argus" code lens |
| `argus.bash.useIntegratedTerminal` | `true` | Run bash tool calls in the integrated terminal |

## How it works

Argus spawns the Claude Code CLI as a subprocess per chat session, streaming responses back into the webview. All file edits go through the same tool approval flow as the CLI. Your conversation stays local; the CLI talks to Anthropic's API directly under your own account.
