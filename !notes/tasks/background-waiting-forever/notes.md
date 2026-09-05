# "Waiting N background tasks" never clears

Status: FIXED, mock e2e green (15/15 in the spec, 53/53 across neighbouring specs), regression cases verified red against the old reducer. Not yet exercised against a real long-lived task end to end.

Reported 2026-08-27: "почти каждый день встречаю этот баг, вроде бы сессия уже закончилась, но как-то типа процесс не завершился", with a screenshot of `✻ Waiting 3 background tasks (2/3)` sitting under a finished turn.

## What it actually was

Not a stuck process. The counter was telling the truth: of 3 background tasks one really was still alive. The defect was that Argus treated "a task is still running" as "the session is still working", and nothing could ever end that state.

`reducer.ts`'s `done` case, when the CLI reported pending tasks, committed the assistant message and then **re-armed a synthetic streaming state** (`backgroundWaiting: true`), keeping `isStreaming` true and *not* incrementing `turnCompletions`. Consequences:

- The spinner ran until some *later* turn produced a `done`. For a task that never completes there is no later turn, so it ran forever. Only Stop, a new message, `/clear` or New chat cleared it.
- The completion sound and the OS notification are gated on `turnCompletions` (`App.tsx:150`), so **both were silently suppressed** for every turn that spawned a background task, not just the pathological ones.
- Stop stayed armed on an idle session, and `StreamingMessage` had to special-case the fake state with an early `return null`.

Why it hit almost daily: the CDP workflow starts Chrome as a background task (`chrome.exe --remote-debugging-port=9225`). That Bash task ends when Chrome ends, i.e. never during the working day. Any dev server or watcher started with `run_in_background` does the same.

Related, same root cause one step later: such a task is exactly what gets orphaned when the CLI process dies, which is the empty-1s-turn bug ([../empty-1s-turn/notes.md](../empty-1s-turn/notes.md)).

## What upstream does (checked, not assumed)

Grepped the installed CLI (`C:\nvm4w\nodejs\node_modules\@anthropic-ai\claude-code\bin\claude.exe`, Bun-compiled, see [../../common/cli-bundle-mining.md](../../common/cli-bundle-mining.md)):

- `"each blocking tool call returns immediately with a \"running in the background\" tool_result and the turn continues; the task keeps running and emits a task_notification"` - the turn ends, full stop.
- `/tasks` (aliases `/bashes`): `"View and manage everything running in the background"` - the pending set is a passive list, never a spinner on the transcript.
- `"Summary of what happened while the user was away (background tasks completed, notifications accumulated)"` - completions are reported after the fact.
- Orphans are reaped, not waited on: `"N orphaned background task(s) after restart"`, `"Stopped by a worker restart"`.

So the "waiting" state was an Argus invention. The fix is to delete it rather than to detect never-ending tasks (undecidable: a 40-minute build and a browser held open for CDP look identical from here).

## Changes made

- `webview/src/reducer.ts` - `done` commits the turn identically whether or not tasks are pending (`streaming: null`, `isStreaming: false`, `turnCompletions + 1`). `thinking_start` loses the `inheritStart` guard that existed only to avoid inheriting from the synthetic state (`prev` is now always a real streaming state).
- `webview/src/types.ts` - `StreamingState.backgroundWaiting` removed.
- `webview/src/components/StreamingMessage.tsx` - the `if (streaming.backgroundWaiting) return null` early exit removed.
- `webview/src/components/WorkingIndicator.tsx` - back to being only the live-turn spinner: the background branch, the `startTime`/`lastEventTime` props, the 1s interval and the `formatDuration`/`plural`/`message.module.css` imports are gone.
- `webview/src/components/BackgroundTasksNote.tsx` + `.module.css` (new) - static footnote, `data-testid="background-tasks-note"`, "1 background task still running" / "2 of 3 background tasks still running" (it reports what is *pending*, derived as `total - completed`). **Superseded 2026-09-03**: the denominator is gone and the component takes a plain `pending` prop, because the total was counted since the last per-send reset and rendered "2 of 9" on a turn that launched two. See [../bg-task-indicators/notes.md](../bg-task-indicators/notes.md).
- `webview/src/components/ChatMessage.tsx` - renders the note instead of a `WorkingIndicator`; the response timer is no longer suppressed for `background_waiting`/`background_done` (the turn finished, so it shows its duration like any other); the now-dead `logCount` prop dropped, and with it the pass-through in `MessageList.tsx`.
- `e2e/background-tasks.spec.ts` - rewritten for the new semantics, plus the two regression cases below.
- Docs: [../../background-tasks.md](../../background-tasks.md) UI section rewritten, `CLAUDE.md` bullet updated.

Backend untouched: it already ships the counters on `done` and already runs the notification turn.

## Verification

- `node node_modules/@playwright/test/cli.js test --config "!notes/common/scripts/playwright.mock-only.ts" e2e/background-tasks.spec.ts` -> 15 passed (6.1s). The escape-hatch config because the user's own `yarn dev` was running and the config guard is a hard stop; this spec writes no server settings, so it is safe there ([../../common/e2e-testing.md](../../common/e2e-testing.md)).
- Red run: reducer temporarily reverted to `isStreaming: hasPendingBg` / `turnCompletions` frozen -> both new cases fail ("a turn with a pending task finishes instead of staying live", "completion sound fires even though a task is still running"), then restored.
- Neighbours (the `thinking_start` and timer edits): `sound-complete`, `retry-indicator`, `retry-clean`, `pending-tool-pulse`, `send-while-streaming`, `stop-no-error`, `thinking-block`, `modal-persistence` -> 53 passed.
- `npx tsc -p webview/tsconfig.json --noEmit` -> only the pre-existing `FileViewerModal.tsx` `SyntaxHighlighter` JSX-typing error, untouched by this work.
- `yarn build` -> ok.

## Remaining work

- Not yet observed against a real never-ending task in the extension. The daemon serving a panel may run from an installed `~/.vscode/extensions/local.argus-<v>/`, which never reads this repo's `media/`, so confirm the running build before judging the UI ([../../common/backend-restart.md](../../common/backend-restart.md)).
- Integration specs were not run (nothing here touches the backend), and the full mock suite was not run through the escape hatch (`model-picker.spec.ts` reads server settings and would fail against the real config).
- Open question, deliberately left alone: a task that will never finish still leaves its note on the transcript forever. That matches upstream's `/tasks` list and is honest, but if it becomes noise the answer is a "Stop task" control (the CLI has `KillShell`/`KillBash`), not a timeout.
