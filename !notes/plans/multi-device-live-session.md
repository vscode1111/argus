# Multi-device live session ("group chat" semantics)

**Status:** open (connect-time attach subset implemented via [session-deep-link](session-deep-link.md), 2026-07-24)
**Created:** 2026-07-21

> **Partial implementation note (2026-07-24):** the deep-link work added the attach machinery at *connect* time: `channel.addClient(ws, fresh, sessionId)` scans the channel's entries for `state.sessionId === sessionId` and joins that entry (overriding `fresh`), plus `channel.replayHistory(ws)` for the initial sync. Still open from this plan: `handleResumeSession` attach-first (the Session History click path still replays from disk even when the session is live in memory), the `isBrowsing` false-live fix, and the `liveIds` discovery field.

## Goal

Opening the *same* session from a second client - another browser, another machine, a phone - should behave like joining a Telegram group chat:

- Messages, streamed text, tool calls and token counts arrive **live in every connected client at once**, with no refresh and no manual resume.
- Any client can **stop** the running turn and **start** a new one; the effect is visible to all the others immediately.
- Leaving and coming back re-syncs to the current state rather than to a stale snapshot.

## Motivation

Long sessions run on the desktop. The user wants to **supervise and steer them remotely from a phone**: watch a long turn progress while away from the machine, stop a run that has gone the wrong way, and send the next instruction - without touching the desktop and without the two views diverging.

This is the difference between "I can read what happened" (works today, via on-disk transcript) and "I am in the session" (does not work today).

## Current behaviour (why this is not already true)

Researched 2026-07-21. Every browser tab is **architecturally isolated**:

1. `webview/index.html:72` and `media/browser.html:87` both set `p.set('client', 'browser')`.
2. `src/backend/index.ts:222` maps that to `fresh: isBrowserClient`.
3. `channel.ts` `addClient(ws, fresh)` calls `joinEntry(cd, ws, fresh ? createEntry(cd) : defaultEntry(cd))`.

`createEntry()` builds a brand-new `SessionEntry` with its own `SessionState`, its own `currentProc`, empty `history` and `snapshot: null`. In `joinEntry`:

```ts
const needsReplay = target.clients.size > 0 || target.history.length > 0 || target.snapshot !== null;
```

All three are false for a fresh entry, so a second tab gets **no replay at all** and is subscribed to a broadcast nobody writes to.

If the user then resumes the same session id in that tab, `handleResumeSession` (`session.ts:454`) calls `loadSession(id, workspaceDir)`, which reads the **jsonl transcript from disk**. That is a static snapshot frozen at read time - which is exactly the observed symptom (second tab shows the history and the tool calls, then never advances).

### Secondary defect in the same path

```ts
const isBrowsing = procRunning && id !== s.sessionId;   // session.ts:459
```

In a fresh entry `currentProc` is `undefined`, so `procRunning` is false, so `isBrowsing` is false. The tab is marked **live** (`setBrowsing(ws, false)`, `token_update` sent) while attached to an entry that has no process. It presents itself as a live view of a session it cannot receive events from.

### Risk to verify before building

If the second tab sends a message, it will spawn a **second CLI** with `--resume <same id>` while the first tab's CLI is still appending to that transcript. Two processes writing one jsonl is a plausible corruption path. *This was derived by reading the code, not reproduced* - reproduce it first, since it may need fixing independently of this feature.

### Note on scope

Extension panels are **not** affected: they do not set `client=browser`, so `fresh` is undefined and they join `defaultEntry` and already share sessions correctly. Only browser clients are isolated. Also note `fresh` is currently **uncommitted working-tree code**, so changing it is cheap.

> **Superseded (2026-07-30)** - see the [Superseded](#superseded) block at the end of this
> file. Panels joining `defaultEntry` turned out to be a defect, not correct behaviour.

## Design

Two options were considered.

### Option A - drop `fresh` for browser clients (rejected as the primary path)

Let browser tabs join `defaultEntry` like extension panels. Live sync then works with no other change, because history replay on join already exists.

Rejected because it conflates two different user intents: "open Argus" (should give me a fresh chat) and "join the session that is running" (should attach). It would also likely regress e2e, where each Playwright page needs isolation - which is probably why `fresh` was introduced.

### Option B - attach-by-sessionId (recommended)

Keep isolation on open. Make *resuming* a session that is **live in memory** attach to that entry instead of replaying from disk.

1. Add a lookup to the `Channel` facade (no search by `sessionId` exists today):
   ```ts
   /** Find a live entry currently bound to this sessionId, if any. */
   findEntryBySessionId(id: string): SessionEntry | undefined;
   /** Move a client into an existing entry (history + snapshot replay). */
   attachToSession(ws: WebSocket, id: string): boolean;
   ```
2. In `handleResumeSession`, try `attachToSession(ws, id)` **first**. On success, `joinEntry` already delivers `sessionLoaded` + `replaySnapshotToClient`, so the client lands mid-stream correctly. Only fall back to `loadSession(id, ...)` when no live entry owns that id.
3. **In-memory state wins over disk.** The transcript is behind by definition during a live turn.
4. Leaving the old entry is already handled by `joinEntry` (removes from `prev.clients`, schedules cleanup if it empties).

### Stop / start from any device

Largely free once clients share an entry: `handleStop(s)` operates on the entry's `SessionState` and emits through `s.broadcast`, which is entry-scoped, so `done` and the cancelled-tool events reach every attached client. Verify explicitly:

- Stop from device B ends the turn started on device A, and A's UI leaves the streaming state (no orphaned Stop button).
- After a stop, either device can send the next message and both see it.
- `newSession` from one device must **not** silently drag the others into a new entry - decide and document the intended semantics (proposal: it moves only the initiating client, matching today's `moveToNewSession`).

## Deep link: session id in the URL

Split out into [session-deep-link](session-deep-link.md) - opening a session by URL (`?session=<id>`), server-side workspace resolution, and the "copy link" affordance. It builds on the attach-by-sessionId work here and is the primary path for the phone use case, but it is a separable layer: this plan makes attaching possible, that one makes it addressable.

## Discovery: reuse Session History (secondary path)

For finding a session you do not have a link to, the existing `SessionHistoryModal` (history clock button -> "This workspace" tab) is the right surface - no new UI is needed. It already lists sessions sorted by mtime, so a running session floats to the top, and clicking a row already routes through `resumeSession`, which is exactly the message Option B changes to attach-first.

One gap has to be closed. Today the reply is:

```ts
// session.ts:269 / :275 / :278
ws.send(JSON.stringify({ type: 'sessionList', sessions: listSessions(s.workspaceDir), currentId: s.sessionId }));
```

`currentId` is **the requesting client's own `s.sessionId`**, so the green `.rowCurrent` highlight means *"the session I am pointing at"*, not *"a session that is live somewhere"*. Consequences for the phone case:

- A freshly opened tab has an isolated entry with `sessionId === undefined`, so **nothing is highlighted at all** and a running session is visually indistinguishable from a finished one.
- The user cannot tell which row will **attach** (live) and which will **replay** (frozen transcript) - the distinction this whole feature introduces.

Proposed addition: derive liveness **channel-wide**, not per-client, and send it alongside:

```ts
// ids of sessions that currently have an entry with a running proc
liveIds: string[]   // from cd.entries: state.sessionId where currentProc && !cliDone
```

Render those rows with a distinct "running now" affordance (dot / pulse), kept visually separate from the existing green "current" highlight, since the two can differ - a session can be live in another entry while this client points elsewhere. This also gives the user an honest expectation of what the click will do.

Applies to the "All workspaces" tab (`allSessionList`, `session.ts:282`) too; liveness there must be computed across all channels in the registry, not just the current `workspaceDir`.

## Open questions

- **Concurrent input.** Two devices can send mid-turn. Today that is a stdin inject (`user_inject`), which already broadcasts - probably correct as-is, worth confirming it renders sanely on both.
- **Attach limit.** Any reason to cap clients per entry? Probably not, but broadcast cost is O(clients) per chunk.
- **Auth for remote devices.** Reaching this from a phone needs `allowNetworkAccess` + the phone's origin in `allowedOrigins`, plus the nonce. Current LAN usage (`10.35.4.120:5173`) already exercises this path; confirm nothing extra is needed off-LAN.

## e2e coverage to add

Integration spec with **two pages** against one backend (extend `shared-channel-integration.spec.ts`, which already drives multiple clients):

1. Page A starts a long turn; page B resumes that session id → B receives live `text_chunk`s (not a frozen replay), asserted by content growing after attach.
2. Page B clicks Stop → page A's Stop button disappears and the turn is marked stopped.
3. After the stop, page B sends a message → page A sees it.
4. Resuming a session id that is **not** live still replays from disk (no regression).
5. Session History on a freshly opened client marks the session running on the other client as live (`liveIds`), while `currentId` stays unset - the two must not be conflated.

Deep-link cases live in [session-deep-link](session-deep-link.md).

Follow the stable-assertion rules in [../common/e2e-testing.md](../common/e2e-testing.md): gate on the Stop button, never on tool calls.

## Files likely touched

| File | Change |
|------|--------|
| `src/backend/channel.ts` | `findEntryBySessionId` / `attachToSession` on the `Channel` facade |
| `src/backend/session.ts` | `handleResumeSession`: attach-first, disk fallback; fix the `isBrowsing` false-live case; add `liveIds` to `sessionList` / `allSessionList` |
| `webview/src/components/SessionHistoryModal.tsx` | "running now" affordance on live rows, distinct from the `.rowCurrent` highlight |
| `e2e/shared-channel-integration.spec.ts` | Two-client live-attach + remote-stop tests |
| `CLAUDE.md` | Multi-session shared-channels bullet: attach semantics |

## Superseded

**Was:** "Extension panels are not affected: they join `defaultEntry` and already share
sessions correctly. Only browser clients are isolated." (Note on scope, 2026-07-21)

**Actually:** joining `defaultEntry` is exactly what made two panels in one workspace share
a single conversation and echo each other's turns. Extension clients now pass a stable
`?panel=<uuid>`; `SessionEntry.owner` binds each panel to its own entry, and a reconnect
(reload, daemon restart) rejoins that entry instead of whatever was last active.

**Why it was wrong:** the claim was derived from the code path alone - panels *do* share
state, and for the multi-device goal that reads as the desired end state. What it missed is
that two panels are two windows the user opened deliberately, so shared state presents as
crosstalk rather than as collaboration. Sharing is only wanted between clients that opted
into the *same session*, which is what the deep link expresses.

**Corrected by:** [tasks/panel-isolation-and-session-info](../tasks/panel-isolation-and-session-info/notes.md) (2026-07-30)
