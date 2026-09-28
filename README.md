# argus

VS Code extension: AI coding assistant with streaming tool calls, inline diff viewer,
and custom skill support. Built in TypeScript, active in 2026.

## Overview

Argus runs Claude Code or Codex conversations in a VS Code webview or browser.
The provider button beside the composer opens the account and model picker.
Switching provider starts a new conversation; existing conversations retain their
provider and can be resumed from history. Models and reasoning options apply to the
current conversation. Use **Use for new conversations** to save a default.

## Architecture

```text
React webview / browser
  <-> WebSocket server, workspace channels and conversation state
  <-> provider registry (AgentProvider + AgentSession)
       | Claude Code: existing streaming CLI execution
       | Codex: bidirectional app-server JSONL RPC over stdio
```

Adapters own native protocols, model discovery, account usage, skills and history.
The UI consumes shared events and capability descriptors. Session bindings and
selection are saved in argus-provider-sessions.json beside argus.json; native
transcripts and authentication remain with their runtimes. Existing Claude
configuration and transcript paths are unchanged.

For Codex, install the CLI on the **server machine** and sign in there with
`codex login`. Argus uses that login. If the executable is not on PATH, set
`ARGUS_CODEX_BIN` to its executable path before starting the server. The adapter
uses `codex app-server`; it was verified with 0.155.0-alpha.16. It discovers models
and supported effort levels from the signed-in runtime.

Codex supports text/images, command and file-change approvals, and user-input
requests. The composer offers Ask (workspace-write with on-request approvals),
Plan (read-only), and Full (unrestricted access without approval prompts).
Unsupported permission requests are rejected. A timed-out
turn is never automatically replayed. PDF input, Claude-specific usage attribution,
background-task markers and transcript tool-image preview remain Claude features.
Codex history currently lists conversations created through Argus. Provider switching
does not transfer context. Inline completions still use their existing Claude path.

Add a provider by implementing the contracts in src/backend/providers/types.ts,
registering it in registry.ts, and translating native events inside the adapter.
Do not add native protocol branches to React components. Run `npm run test:providers`
for the transport/lifecycle contract tests and the provider picker/switch Playwright
specs for the browser workflow.

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
- A CLI process panel, opened from the process counts in Settings > Info: every Claude CLI running on the server's machine with its pid, session, uptime, CPU and memory, grouped under the process that started each one (the daemon, a dev server, a terminal). Any single one can be terminated from its row, and a session that is mid-turn is marked as such.
- Optional idle-CLI timeout (Settings > Watchdog): a finished turn keeps its CLI alive for reuse, which costs ~250MB per abandoned panel, so a limit in seconds reclaims them. Only ever an idle process - one mid-turn is never touched - and the conversation survives, since the next message respawns with `--resume`.
- Optional connection idle timeout (Settings > Network): closes a WebSocket connection that has sat unused this long, to stop an abandoned panel showing up in "Active connections" indefinitely. A connection mid-turn is never touched, and a panel reconnects on its own once it is looked at again.
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

- At least one installed, authenticated provider CLI: Claude Code (`claude` to
  log in) or Codex (`codex login`). Codex requires the `app-server` command.
- On Windows, Codex uses `ARGUS_CODEX_BIN` when set, then `codex.exe` on PATH,
  then the newest executable in the installed desktop app's local bin cache.
  This also works from terminals that do not inherit the desktop app's PATH.
- VS Code 1.85 or newer.

## Provider integration tests

Run `npm run test:e2e:integration -- --retries=0` for the full integration project.
Shared scenarios use the real Codex runtime by default. The fixture selects and
restores `e2e/argus.json` for each case; integration tests run with one worker.

- `@shared`: provider-independent behavior, exercised with Codex by default.
- `@codex`: native Codex capabilities and protocol behavior.
- `@claude`: Claude-specific formats, configuration or launch arguments; local
  checks still run without Claude network access.
- `@claude-live`: requires a working Claude account/network connection and is
  skipped unless `ARGUS_TEST_CLAUDE=1`. Existing unsupported AskUserQuestion cases
  remain explicitly skipped even with that switch.

Set `ARGUS_TEST_PROVIDER=claude` to exercise shared cases with Claude when access
is available. `npm run test:providers` runs the isolated app-server contract tests.
For Codex-only shared/native integration coverage, use
`npm run test:e2e:integration -- --grep "@shared|@codex" --retries=0`.

## License

Proprietary.
