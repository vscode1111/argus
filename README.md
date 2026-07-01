# argus

VS Code extension: AI coding assistant with streaming tool calls, inline diff viewer,
and custom skill support. Built in TypeScript + NestJS, active in 2026.

## Overview

Argus embeds a Claude Code CLI session directly in VS Code as a side panel. It streams
responses in real time, shows collapsible thinking blocks, renders tool calls (file
reads, edits, bash, search) with inline diff and file viewers, and lets you approve or
reject each action before it runs. Custom slash-command skills live in
`~/.claude/skills/` and are loaded automatically.

The goal: full Claude Code capability without leaving the editor, with a UI layer that
makes long agentic sessions readable.

## Architecture

```
VS Code webview (React + TypeScript)
  <- streaming SSE from NestJS backend (localhost)
NestJS backend
  -> spawns Claude Code CLI as a subprocess per session
  -> pipes CLI stdout/stderr back to the webview as SSE
  -> relays tool approvals from webview to CLI stdin
Claude Code CLI
  -> talks to Anthropic API under your account
  -> executes tool calls (read, write, edit, bash, grep, ...) locally
```

All file edits go through the same tool-approval flow as the standalone CLI. Conversation
history stays local.

## Key decisions

**CLI-as-subprocess, not API-direct:** spawning the CLI means Argus inherits all CLI
features (tools, skills, MCP servers, slash commands) without reimplementing them.
Switching models or adding a new tool requires no changes to Argus.

**NestJS over plain Node HTTP:** the backend manages multiple concurrent sessions (one
per chat panel). NestJS's module system makes session lifecycle, SSE endpoint, and
approval routing cleanly separable without growing into a monolith.

## Commands

| Command | Shortcut | Description |
|---------|----------|-------------|
| Argus: Open Chat | `Ctrl+Shift+A` | Open a new chat panel |
| Argus: Ask About Selection | `Ctrl+Shift+Q` | Send highlighted code with a question |
| Argus: Edit Selection with AI | - | Apply an AI edit to the selection |
| Argus: Review Selection | - | Run a code review on the selection |
| Argus: New Session | - | Start a fresh conversation |

## Features

- Streaming chat with real-time tool calls (read, write, edit, bash, grep, glob, web fetch).
- Live token counter: input and output counts update during streaming.
- Collapsible thinking blocks with token estimate; click to expand.
- Plan mode: dry-run exploration without file edits.
- Slash commands: built-in and custom skills from `~/.claude/skills/`.
- Image paste via `Ctrl+V`.
- Inline diff and file viewers next to tool calls.
- OS toast notifications on task completion.
- Optional "Ask Argus" code lens above functions and classes.
- Optional inline completions (Haiku model, Copilot-style).

## Settings

| Setting | Default | Description |
|---------|---------|-------------|
| `argus.model` | _(CLI default)_ | Chat model (any CLI-supported name) |
| `argus.inlineCompletions.enabled` | `false` | Enable inline code completions |
| `argus.inlineCompletions.debounceMs` | `500` | Debounce for inline completions |
| `argus.codeLens.enabled` | `true` | Show "Ask Argus" code lens |
| `argus.bash.useIntegratedTerminal` | `true` | Run bash tool calls in integrated terminal |

## Requirements

- [Claude Code CLI](https://docs.anthropic.com/claude/docs/claude-code) installed and
  authenticated (`claude` in terminal once to log in).
- VS Code 1.85 or newer.

## License

Proprietary.
