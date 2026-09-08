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
- Context usage pill showing how full the window is, as a share of the active model's own window (200k or 1M depending on the model, not a fixed number).
- Collapsible thinking blocks with token estimate; click to expand.
- Plan mode: dry-run exploration without file edits.
- Slash commands: built-in and custom skills from `~/.claude/skills/`.
- Model picker with live model list and per-family descriptions; model data (list, descriptions, detected CLI default) auto-refreshes daily via the daemon (`yarn update-models` to force).
- Image paste via `Ctrl+V`.
- Inline diff and file viewers next to tool calls. An `.html` file opens as the rendered document, painted in the panel's own theme, with its source one click away.
- Images a tool read open from the conversation itself, so a file the agent has since renamed, packaged or deleted still previews; the bytes are fetched per click instead of travelling inside the message.
- Clickable paths and URLs everywhere in messages, including code blocks: a file path opens an in-app preview (dotted underline), a URL opens in the browser.
- A path pointing at a **folder** opens a browsable listing with file-type icons and sizes, sorted folders-first like an explorer: click a sub-folder to walk in, a file to preview it, Back to walk out.
- OS toast notifications on task completion. A turn the CLI started by itself, to report a finished background task, stays silent while more are still running, so a long watch does not ping every few minutes; the one that ends the chain still notifies.
- A `✻ N` pill beside the context pill counts the background tasks running right now, for as long as they run.
- A turn the CLI started by itself says so: it opens with the report of the background task that woke it ("Background command "Watch CI until all checks complete" completed (exit code 0)") and a link to that task's output, instead of appearing out of nowhere. Its completion time is shown in a neutral colour rather than the success green while any task is still running.
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
