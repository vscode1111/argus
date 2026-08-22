# Session routing: sends and resumes reaching the wrong entry

Two related bugs, both from the same underlying gap: the server tracks sessions per
**entry**, but `session.ts` handlers only ever operated on *the client's current entry*,
never asking which entry actually owns the session in play.

| | |
|---|---|
| Status | BOTH FIXED / verified (red run reproduced each, green runs pass) |
| Reported | 2026-08-22, by the user, from a live Argus session (screenshots) |
| Produced by | Claude Code, model claude-opus-5 |

- **Bug 1** - a send while browsing another session was injected into the turn the client
  left. Details below.
- **Bug 2** - returning to a session that is streaming in another entry showed no progress
  indicator and never updated. Found by the user immediately after Bug 1 was fixed, because
  the Bug 1 fix (detaching into a new entry) makes the second entry commonplace. See
  [Bug 2](#bug-2---resuming-a-session-streaming-in-another-entry) at the end.

## Bug 1 - send while browsing lands in the wrong session

## Symptom

A prompt typed in one session appeared in a **different** session, rendered as a mid-turn
inject bubble inside that session's running turn. The user's second screenshot shows
`Analyze that project 2` sitting between two `Bash` blocks of an unrelated streaming turn.

The sender saw nothing at all: their own message never appeared in their own view.

## Root cause

`handleSend(s, msg)` (`src/backend/session.ts`) takes only the entry `SessionState`, never
the `ws`. It therefore cannot tell **which client** sent the message, and its first branch
fires purely on whether the *entry* has a live process:

```ts
if (s.currentProc?.stdin?.writable && !s.cliDone && !msg._silent && !msg._askResume) {
  // ... writes into the running CLI's stdin
```

Sequence:

1. Session **A** is streaming in entry `E`.
2. The user opens session **B** from Session History. `handleResumeSession` computes
   `isBrowsing = procRunning && id !== s.sessionId` -> true. It deliberately leaves
   `s.sessionId` pointing at **A** (so the live turn's `--resume` arg stays correct) and
   marks the client browsing.
3. **Nothing recorded that the client is now looking at B** - the id was used to load the
   transcript and then discarded.
4. The user types. `handleSend` runs against entry `E`, whose `currentProc` is A's live
   CLI, and takes the inject branch.
5. The text goes into A's stdin and is broadcast as `user_inject` - which is in
   `SESSION_STREAM_EVENTS`, so it is gated *away from the browsing sender* and delivered
   to everyone else watching A.

Synthetic sends were never affected: the watchdog retry and the AskUserQuestion follow-up
pass `_silent` / `_askResume`, which that guard already excludes. Only genuine user sends
reach it, all from the single `ws`-bearing call site in the message handler.

## Fix

Option (a) of three considered - detach and start a turn on the session actually on screen.
(The alternatives were refusing the send, or keeping the inject but ungating the feedback;
both leave the user unable to do the obvious thing.)

- `ChannelData.clientViewing: Map<WebSocket, string>` - the session a browsing client has
  on screen. Needed because the entry's own `sessionId` must keep pointing at the streaming
  session, so it cannot double as this.
- `setBrowsing(ws, browsing, sessionId?)` records / clears it.
- `detachToBrowsedSession(ws)` moves a browsing client into its own entry bound to that id
  and returns the state; `undefined` when not browsing. Transfers `owner` exactly as
  `moveToNewSession` does, so a later reconnect rejoins the session the user is really in.
- The `send` handler calls it **before** `handleSend`. The new entry has no proc, so the
  normal spawn path runs with `--resume <browsed id>`; the abandoned session keeps
  streaming untouched.
- `clientViewing` is cleared on `setBrowsing(…, false)`, `moveToNewSession`,
  `detachToBrowsedSession` and `removeClient`.

## Files changed

- `src/backend/channel.ts` - `clientViewing` map, `setBrowsing` signature,
  `detachToBrowsedSession`, cleanup in `removeClient` / `moveToNewSession`, `Channel` docs.
- `src/backend/session.ts` - record the browsed id in `handleResumeSession`; detach-first
  in the `send` handler.
- `e2e/browse-send-routing-integration.spec.ts` - new, two tests.
- `e2e/shared-channel-integration.spec.ts` - `ARGUS_E2E_PORT` override only, no test changes.
- `CLAUDE.md` - `channel.ts` entry, a new Key Convention bullet, the e2e listing.

## Verification

Red run with the fix reverted reproduced the reported symptom exactly:

```
Received array: [{"text": "scub-browsed-send", "type": "user_inject"}]
```

and the sender timed out waiting for its own message echo. With the fix, both tests pass
(15.1s). `e2e/shared-channel-integration.spec.ts` re-run green (11/11), including the three
browsing-specific regressions. `tsc -p ./` clean.

### Running it without disturbing a dev server

The user's `yarn dev` on `:3001` was serving a live Argus tab and pointed at the real
`~/.claude/argus.json`, so the `global-setup.ts` config guard would have refused the run and
stopping it would have dropped their session. Instead the spec takes `ARGUS_E2E_PORT` and
was verified against a throwaway backend:

```bash
ARGUS_CONFIG="<repo>/e2e/argus.json" ARGUS_SERVER_PORT=3099 npx tsx server/index.ts
ARGUS_E2E_PORT=3099 npx playwright test \
  --config "!notes/tasks/browse-send-routing/scripts/playwright.isolated.ts" browse-send-routing
```

`scripts/playwright.isolated.ts` is the ad-hoc runner (no `globalSetup`, no `webServer`,
`workers: 1`). It is a verification aid, not part of the normal suite - the spec itself
defaults to `:3001` and runs in the `integration` project unchanged.

Note the dev server watches `src/backend/`, so editing these files silently restarted the
user's own server onto the new code mid-session.

## Bug 2 - resuming a session streaming in another entry

**Symptom (user, straight after Bug 1 was fixed):** returning to an in-progress session via
the Session History modal showed no progress indicator and no further output.

**Cause:** `handleResumeSession` only rebound **the client's own entry's** `sessionId` and
replayed **that entry's** snapshot. It never moved the client to the entry that actually
owns the live turn, so the session was served from `loadSession` - and the transcript on
disk stops at the last committed turn. The client got a stale view while the turn ran on
invisibly elsewhere.

Pre-existing (it needed the session to be live in a *different* entry, e.g. a second panel),
but the Bug 1 fix made it routine: detaching on a browsed send is exactly how a client ends
up outside the entry streaming the session it wants back.

**Fix:** `channel.attachToLiveSession(ws, sessionId)` scans for an entry whose state has
that `sessionId` with a live `currentProc` and `cliDone === false`, skipping the client's
current entry (already being there is an ordinary return-to-live resume, which the existing
branch already replays correctly - that path is covered by
`shared-channel-integration.spec.ts` and must keep working). It `joinEntry`s the client, so
the entry's history + streaming snapshot replay and the indicator returns.
`handleResumeSession` calls it first and returns early, after sending a `token_update` (the
snapshot replay restores blocks but not the counters behind the timer).

**Verified:** red run timed out waiting for `thinking_start` - exactly the reported symptom.
Green run passes (4.0s), plus `shared-channel-integration` 11/11 and
`panel-isolation-integration` 3/3 still green.

## Remaining work

- Not committed. Lands on top of the uncommitted session-active-marker work in the same two
  files.
- `session-browse-during-stream-integration.spec.ts` was **not** re-run (browser-driven, so
  it needs the full `:3001` + Vite harness). It browses and returns without sending, and the
  return-to-own-entry path is deliberately unchanged, but that is reasoning, not a green run.
  It is the highest-value thing to run next.
- `stop-then-send-integration.spec.ts` passed, but it has no `ARGUS_E2E_PORT` override yet,
  so it ran against the user's own `:3001` under the real `~/.claude/argus.json` rather than
  the e2e config. Treat as a weak signal; give it the override.
- Worth considering separately: `getClientState(ws)` silently falls back to
  `defaultEntry(_cd)` when a socket has no mapping, which routes to whichever entry is most
  recently active - i.e. the streaming one. Not the cause of either bug, but the same class
  of failure: guessing an entry instead of resolving one.
