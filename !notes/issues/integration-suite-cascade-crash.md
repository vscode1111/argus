# Integration suite: 29 failures from one backend crash

**Status:** resolved / verified (96-97 pass, backend survives the full run)

## Symptom

A full `integration` run reported **29 failed, 4 skipped, 9 did not run** across specs with nothing in common: `session-history`, `slash-commands`, `token-spending`, `workspace-browse`, `workspace-name`, `shared-channel`, `streaming-partial`, ...

The scale is the trap: 29 unrelated specs failing looks like 29 regressions, and the natural reflex is to open them one by one.

## It was one cascade, not N bugs

Two signals identify it:

1. **27 of the 29 failures showed the same page state:** `"Disconnected, reconnecting..."`. The app had mounted; the WebSocket was dead.
2. **They failed in run order** from a point onward - everything before that point passed, everything after failed.

That is a single shared-backend death, not independent failures. Confirm before debugging any individual spec:

```bash
netstat -ano | grep ":3001 .*LISTENING"   # nothing => the backend is gone
```

## Root cause chain

The dev-server log (not visible through Playwright's `webServer` - see below) held the whole story:

```
oh no: Bun has run out of memory.
Error: spawn UNKNOWN
    at handleSend (src/backend/session.ts:382:12)
```

Reading backwards:

1. **`scheduleEntryCleanup` evicted `SessionEntry`s without killing their CLI process.**
   Once an entry is deleted from `cd.entries` it is unreachable - no client can ever rejoin it - so its `claude` child process lingered for the life of the server with nobody consuming its output.
2. **The `client=browser` fresh-entry routing made it severe.** `addClient(ws, fresh)` gives each browser client its own isolated entry, so every e2e page created (and then abandoned) a new entry - one leaked CLI per test.
3. **Process pileup exhausted the machine**, and the OS started refusing new processes.
4. **`spawn()` throws _synchronously_ on that refusal** (`spawn UNKNOWN`, errno `-4094`). `handleSend` only handled the async `proc.on('error')` path, so the synchronous throw propagated out of the WS message handler and **killed the whole server process**.
5. Every test after that point hit a dead socket.

Note the asymmetry that hid the bug: the async error path was handled and treated as a per-turn error, so the failure mode only appears under the resource pressure that triggers the sync path.

## Fixes

| File | Fix |
|------|-----|
| `src/backend/session.ts` (~382) | Wrap `spawn()` in `try/catch`; on failure clear `currentProc`/`currentProcKey`, set `cliDone`, and broadcast `error` + `done` to that client only. A spawn failure is now a per-turn error, never a process-level one. |
| `src/backend/channel.ts` (`scheduleEntryCleanup`) | `killProc(entry.state.currentProc)` when the 30s grace timer evicts an entry, then clear the proc fields. Reclaims the leak at its source. |
| `playwright.config.ts` | Add `workers: 2` to the `integration` project (see below). |

Verified empirically after the fix: `claude --print` processes remaining after a full run were all children of the user's real daemon; **zero** e2e orphans.

## The `workers: 2` cap was documented but never implemented

`CLAUDE.md` already described an integration worker cap and even described this exact failure mode ("4-wide exhausts memory/CPU so the backend stops responding mid-run"). `git log -p playwright.config.ts` proved it had **never** been added to the config - only the global `workers: 4` existed.

Lesson: a documented invariant is not an enforced one. When docs describe a config value, verify it is actually in the file before trusting it as the current state.

## Gotchas

- **Playwright's `webServer` swallows backend stdout.** With `webServer` in charge, the crash output above is invisible and the run looks like 29 mysterious assertion failures. Run the backend yourself to see it:
  ```bash
  yarn dev > /tmp/be.log 2>&1 &
  npx playwright test --project=integration --no-deps
  ```
  This is what finally produced a diagnosis - and a clean run.
- **A syntax error in a backend edit looks exactly like flakiness.** A stray `}` left in `session.ts` produced `Error: Transform failed ... Unexpected "}"`, tsx failed to restart, and the next several runs were "flaky tests" that were really "backend never started". Run `yarn compile` after backend edits, and check the tsx log before blaming a test.
- **Do not trust a run whose backend was started inside the same turn** as a long agent operation; a torn-down dev server produces the same disconnect signature and wastes a diagnosis cycle.
- On this shell, `node -e` with a `/tmp/...` path resolves to `D:\tmp` / `C:\tmp`. Use `cygpath -w` or the explicit `C:/Users/Admin/AppData/Local/Temp/...` path.

## Related

- Test-level flakiness fixed in the same pass: see [../common/e2e-testing.md](../common/e2e-testing.md) ("Writing stable integration assertions").
- A real product bug surfaced on the way: `handleResumeSession` sent `inputTokens: undefined` when the count was 0 (`|| undefined`), so browsing away from a live session and back lost the input token count. It now always sends the current values.
