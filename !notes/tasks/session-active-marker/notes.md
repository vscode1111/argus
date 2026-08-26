# Running-session marker in Session History

| | |
|---|---|
| Status | Implemented, not committed. Integration spec **verified green 2026-08-26** (8/8 on `--repeat-each=4`) after its prompt was fixed; see Remaining work |
| Produced by | Claude Code, model claude-opus-5 |

## Problem

Session History listed every past session identically, so a session with a turn running right
now was indistinguishable from a finished one. With per-panel session entries (see
[../panel-isolation-and-session-info/notes.md](../panel-isolation-and-session-info/notes.md))
and deep links, several turns can legitimately be in flight at once in different panels and
different workspaces, and the list gave no way to tell which.

## Design

The marker is a pulsing green dot before the session title (`RunningDot`, `role="img"`,
`aria-label="Working now"`, same green and 1.5s pulse as a pending tool call), rendered in
**both** modal tabs.

The decisive choice: **the running set comes from the server, not from the list rows.** A row
is a disk fact (title, mtime, line count); "is a turn running" is a live process fact that no
transcript can answer. So:

- `listActiveSessions()` (`src/backend/channel.ts`) walks every entry of every workspace
  channel in the registry and reports `{id, workspacePath, startedAt}` for each entry whose
  state has a `sessionId`, a live `currentProc`, and `cliDone === false`.
- `notifyActiveSessions()` pushes that set to every client of every channel via
  `broadcastToAllChannels`.
- `App.tsx` holds the ids in React state and passes `activeIds: Set<string>` into
  `SessionHistoryModal`.

### Why the liveness predicate needs all three terms

Each one alone is wrong, and each was checked against the actual state machine:

| Term | Why it cannot be dropped |
|------|--------------------------|
| `st.sessionId` | Until the CLI reports an id there is no history row to mark. |
| `st.currentProc` | A fresh entry has no process at all. |
| `!st.cliDone` | A **finished** turn keeps its process alive so the next send can reuse it, so `currentProc` stays truthy long after the turn ended. |

### Why the push is coalesced onto a timer

`notifyActiveSessions()` defers with `setTimeout(..., 0)` for two reasons, both load-bearing:

1. It is called from inside the entry broadcast, i.e. *while* the handler that triggered it is
   still mutating `cliDone` / `currentProc`. Reading the flags synchronously would report the
   state from before the transition.
2. A turn boundary emits several `ACTIVITY_EVENTS` (`thinking_start`, `done`, `error`,
   `sessionId`, `clear`) in a burst; the timer collapses them into one message.

It also compares the serialized payload against `lastActivePayload` and sends nothing when the
set is unchanged, and `unref()`s the timer so a pending notify cannot hold the daemon's event
loop open past idle-exit.

### Why eviction has to notify too

`scheduleEntryCleanup` kills the proc of an entry nobody can rejoin. That entry can be
mid-turn, so without an explicit `notifyActiveSessions()` there its row would stay marked as
running forever: no further broadcast is coming from an entry that no longer exists.

### Why the client asks on every reconnect

The server only pushes **on change**. A client that connects after the change (a reload, a
daemon restart, a workspace switch) would therefore see nothing until the next turn boundary.
`App.tsx` posts `getActiveSessions` on mount and on each `ws_status connected`; `session.ts`
answers that one per-client with the current set.

The ids live in `App` state, deliberately **not** in `SessionHistoryModal`'s module-level row
cache: the cache survives close and reopen, so a cached "running" flag would go stale behind a
closed modal while the turn finished.

## Files changed

- `src/backend/channel.ts` - `ActiveSession`, `listActiveSessions()`, `notifyActiveSessions()`,
  `ACTIVITY_EVENTS`, the notify hook in `createBroadcastForEntry`, and the notify on eviction.
- `src/backend/session.ts` - `getActiveSessions` handler (initial per-client sync).
- `webview/src/types.ts` - `ActiveSession` type.
- `webview/src/App.tsx` - `activeIds` state, `activeSessions` handler, `getActiveSessions` on
  mount and on reconnect.
- `webview/src/components/SessionHistoryModal.tsx` - `activeIds` prop, `RunningDot`,
  `data-session-id` on rows in both tabs.
- `webview/src/components/SessionHistoryModal.module.css` - `.runningDot`.
- `webview/index.html` - `getActiveSessions` added to the dev-mode suppression list.
- `e2e/session-history.spec.ts` - mock coverage (marked in both tabs, cleared when the set
  empties).
- `e2e/session-active-marker-integration.spec.ts` - new, two integration tests.
- `CLAUDE.md` - "Running marker" paragraph in the Session history entry, protocol message
  lists (`activeSessions`, `getActiveSessions`), e2e listing.

## Gotchas

### The centered-modal overlay swallows clicks on the app behind it

The first integration test tried to click **Stop** while the Session History modal was open, to
watch the mark clear in place. It timed out: the modal shell renders a full-viewport
`.overlay` (`position: fixed; inset: 0`) as its click-outside-to-close catcher, and Playwright
reported `<div aria-hidden="true" class="_overlay_k6a4k_6"></div> intercepts pointer events`
against a Stop button it had already resolved and found visible, enabled and stable. The
misleading part is that the button passes every actionability check; only the final hit test
fails, so the log reads like a flake rather than a layout fact.

Fix in the spec: press Escape, assert the dialog is gone, then click Stop. The
"mark clears while the list stays open" case moved to the second test, where the stop is
issued from a **different page** and needs no click behind the modal. Not a lost assertion:
a user cannot click Stop through the overlay either.

Artifact of the failing run kept in [artifacts/](artifacts/) (`error-context.md` plus the
screenshot) rather than the usual gitignored `tmp/`, because it is the evidence for this
section. Generalised into
[../../common/e2e-testing.md](../../common/e2e-testing.md).

### Rows need `data-session-id`

Asserting on "the marked row" by position or title is unreliable here, because another entry
may still be finishing and legitimately marked at the same time. Both tabs stamp
`data-session-id` on the row so a test can target exactly the session it started.

## Verification

- Mock: `e2e/session-history.spec.ts` extended (marker in both tabs, cleared when the set
  empties).
- Integration: `e2e/session-active-marker-integration.spec.ts`, two tests (own-page mark and
  unmark; cross-page mark, where the second page proves the set came from the server).
- **The only recorded run of the integration spec is a failure**: `artifacts/.last-run.json`
  holds `"status": "failed"` for the first test, and the stored `error-context.md` is the
  overlay interception described above. The spec was then edited to press Escape first, but
  **no green run is recorded**, and this session did not re-run it.

## Remaining work

- ~~Re-run the integration spec and confirm green before committing.~~ **Done 2026-08-26:**
  green, 8/8 on `--repeat-each=4`. It needed a fix first. `LONG_PROMPT` ("list the numbers
  from 1 to 300") was supposed to keep the turn alive while the modal opens, but the model
  abbreviates rather than emitting 300 lines (6s, ~610 output tokens), so **both** tests in
  the file flaked, alternating between them. The prompt now holds the turn open with a
  foreground Bash `sleep 10`, which does not depend on model speed. See
  [../empty-1s-turn/notes.md](../empty-1s-turn/notes.md) and
  [../../common/e2e-testing.md](../../common/e2e-testing.md).
- Not committed. Sits in the working tree with the browse-send-routing and pending-tool-pulse
  changes, which touch the same files (`channel.ts`, `session.ts`, `SessionHistoryModal.tsx`).
- Scope is **this server process**: a turn running under a different daemon, or a `claude`
  session started outside Argus, is not marked. Acceptable for the intended use (several
  panels on one daemon), but it means an unmarked row is not proof that nothing is running.
- `startedAt` is sent and typed but unused by the UI. Kept because it is what a future
  "running for 2m 14s" label would need; drop it if that never lands.
