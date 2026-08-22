# Interrupted tool call pulses forever after the turn ends

| | |
|---|---|
| Status | FIXED / verified (red reproduced, green passes, control test included) |
| Reported | 2026-08-22, by the user, with a screenshot of a stopped session |
| Produced by | Claude Code, model claude-opus-5 |

## Symptom

A session that had been stopped still showed its last `Bash` tool name pulsing green, as if
the tool were still running. Everything above it had completed normally.

## Root cause

`ToolCall` derived the pulse from the tool alone:

```ts
const pending = !result && !error;
```

That is correct only while the turn is live. A committed message can hold a resultless tool
permanently, and two paths produce one:

1. **A transcript replayed from disk.** `loadSession` attaches each `tool_result` to its
   `tool_use` by id; an interrupted last turn has a `tool_use` with no result. The message
   arrives via `sessionLoaded` with `outcome: 'success'` and never passes through the
   reducer at all.
2. **A turn that ends without its `done` reaching this client.**

The existing cleanup does not cover either. `finalizeBlocks()` - which stamps `error: true`
on still-pending blocks so they stop pulsing - is called from the `done`, `error` and
`ws_status` reducer cases, but it only ever rewrites `state.streaming.blocks`. Once a
message is committed (or was never streamed here), nothing revisits it.

So the pulse outlived the turn, and the UI claimed work was in progress when no process
existed.

## Fix

`webview/src/components/ToolCall.tsx`:

```ts
const pending = !result && !error && !sessionDone;
```

`sessionDone` already existed and was already being passed - `ChatMessage.tsx:156` computes
it (`outcome != null`, excluding `background_waiting` / `background_done`) and passes it to
`ToolCall`, which until now used it only to gate the background-task "Out" link pulse.

`StreamingMessage` deliberately passes **no** `sessionDone`, so it is `undefined` during a
live turn and the pulse behaves exactly as before. That asymmetry is the whole mechanism:
the same block pulses while rendered by `StreamingMessage` and stops when re-rendered by
`ChatMessage` after the turn commits.

## Verification

`e2e/pending-tool-pulse.spec.ts` (mock - this is pure render logic off a message shape).

Red run: 2 failed, 1 passed.

- Both replayed-transcript cases found the pulsing element (`resolved to 1 element`,
  expected 0).
- The **live-turn control passed**, which is what makes the other two meaningful: it proves
  the streaming path was already correct, so the fix could not be "stop pulsing everywhere".

Green run: 3/3 passed.

Full mock suite: **210 passed, 1 failed**. The failure is `model-picker.spec.ts:85` "a dated
list id highlights when the active model is the dateless alias" - the known environment
false positive documented in [../../common/e2e-testing.md](../../common/e2e-testing.md),
confirmed here rather than assumed:

- the escape-hatch config reuses the user's dev server, which runs on the real
  `~/.claude/argus.json` (`model: "claude-opus-5"`) instead of `e2e/argus.json` (`model: ""`)
- the active-model checkmark comes from the server's `workspaceInfo`; `getModels` is in
  `MOCK_SUPPRESSED` but `getInfo` is not
- `model-picker.spec.ts` contains zero references to `toolCall` / `toolName`, so the changed
  code is not reachable from it

`npx tsc -p webview/tsconfig.json --noEmit` clean apart from the pre-existing
`SyntaxHighlighter` JSX-type error in the untouched `FileViewerModal.tsx:261`.

## Files changed

- `webview/src/components/ToolCall.tsx` - one line plus a comment explaining why the
  `!sessionDone` term cannot be simplified away.
- `e2e/pending-tool-pulse.spec.ts` - new, three tests.
- `CLAUDE.md` - "Pending tool animation" bullet, e2e listing.

## Remaining work

- Not committed.
- A resultless tool in a finished turn now renders **neutral**, not as an error. The `done`
  path still stamps `error: true` on blocks it can reach, so the two routes disagree
  cosmetically: a tool interrupted in this session looks errored, the same tool after a
  reload looks plain. Making `loadSession` mark dangling `tool_use` blocks as errored would
  unify them, but that changes transcript-replay semantics for every consumer and was out of
  scope for a "stop the blinking" fix.
- Related but untouched: `background_waiting` / `background_done` outcomes are excluded from
  `sessionDone` by design, so a background task's "Out" link keeps pulsing after the turn
  commits. That is intended (the task really is still running) and the fix does not disturb
  it - `e2e/background-tasks.spec.ts` stayed green.
