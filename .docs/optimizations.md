# Optimizations

## Persistent Claude CLI Process

Both `server/index.ts` (browser dev mode) and `src/agent/AgentSession.ts` (VS Code extension mode) keep the `claude` CLI subprocess alive across turns instead of spawning a fresh one per `send` message. Each spawn would otherwise pay Node startup, CLI bundle load, OAuth token check, MCP server init, and skill discovery (~5s of overhead per turn). The CLI accepts multiple turns over a single stream-json stdin pipe (the same mechanism used by the AskUserQuestion follow-up flow).

### Implementation in `server/index.ts`

- `currentProc` and `currentProcKey` (stringified spawn args, minus `--resume`) live at connection scope. On each `send`, if `currentProc.stdin.writable && currentProcKey === procKey`, the new user message is written to the existing stdin instead of respawning.
- Per-turn state (`buffer`, `stderrOutput`, `receivedDeltas`, `toolMap`, `answeredTools`, `pendingAskTools`, `cliDone`, `suppressCliOutput`) is hoisted to connection scope and reset at the start of each send.
- `attachProcHandlers(proc)` installs stdout/stderr/close/error listeners once per spawn, not per turn. The `result` event handler emits `done` to the client without calling `proc.stdin.end()`.
- The close handler only emits `done` if the proc died before a `result` event (`!cliDone`), to avoid duplicate `done` events.
- Args change (e.g. plan vs edit mode toggle) triggers `currentProc.kill()` and a respawn with `--resume sessionId` to continue the conversation.
- `ws.on('close')` kills `currentProc` and `loginProc` to avoid orphan subprocesses.

### Implementation in `src/agent/AgentSession.ts`

Same `currentProc` / `currentProcKey` reuse pattern, adapted for the async-generator API consumed by `ChatPanel.handleUserMessage`:

- `attachProcHandlers(proc)` parses NDJSON stdout and pushes typed events into an `eventQueue`. The generator drains the queue via `nextEvent()`, which awaits a one-shot `eventResolver` when the queue is empty.
- A `result` event pushes a sentinel `{ type: '__turn_end' }` that ends the generator without closing stdin, leaving the proc warm for the next turn. A `close` event pushes `{ type: '__proc_close', code, stderr }` so the generator can yield a classified error and return.
- `procKey` excludes both `--resume` (added per-spawn) and `--system-prompt` (the system prompt embeds the active file path, which changes constantly; treating it as part of the key would defeat reuse).
- `reset()` (called by `/clear` and "New session") kills `currentProc` so the next send spawns fresh with no `--resume`.
- `sendToolResult()` for an `AskUserQuestion` id pushes a synthetic `tool_end` into the queue and adds the id to `skipNextToolEnd` so the CLI's later auto-`tool_result` is suppressed.

### Measured impact

3-iteration "test" message benchmark, claude-opus-4-6:

| Configuration | Run 1 (cold) | Run 2 | Run 3 | Avg |
|---|---:|---:|---:|---:|
| Per-send spawn (original) | 12.2s | 9.5s | 8.4s | 10.0s |
| Process reuse (current) | 11.6s | 3.5s | 4.3s | 6.5s |

Warm-turn latency drops to ~3-4s, faster than the original Anthropic extension (~5s). The first message still pays cold-start since the proc is spawned lazily on first send.

### Possible future enhancement: prespawn on connect

Spawn the `claude` process when the WebSocket client connects (default edit-mode args) so the first user message also lands on a warm process. Measured impact: cold run 7.8s instead of 11.6s, avg 4.8s. Skipped for simplicity; revisit if first-message latency becomes a UX concern.
