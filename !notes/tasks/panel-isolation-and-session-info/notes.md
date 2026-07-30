# Per-panel session isolation + session/version rows in Settings Info

**Status:** implemented (2026-07-30, working tree)
**Related:** [session-deep-link](../../plans/session-deep-link.md), [multi-device-live-session](../../plans/multi-device-live-session.md), [shared-channel-broadcast](../../plans/shared-channel-broadcast.md)

Two changes that both fall out of the same architectural fact: **the extension and the
daemon are separate installs joined by one machine-global discovery file**, and a
workspace's channel can hold several concurrent sessions.

## Problem

**1. Two panels in one workspace shared a conversation.** Extension clients did not set
`client=browser`, so `addClient(ws, fresh)` joined them to the channel's `defaultEntry`
(the most recently active entry). Opening a second panel in the same workspace therefore
put both panels on one `SessionEntry`: each saw the other's turns echoed into its own
view. The [multi-device plan](../../plans/multi-device-live-session.md) had recorded this
as correct behaviour ("panels already share sessions correctly"); in practice sharing is
what users read as a bug, since two panels look like two independent chats.

**2. The Info tab reported only the UI's own version.** The panel resolves the daemon
through `~/.claude/argus-daemon.json`, so a daemon left running by *another* install
serves a newer panel perfectly well and just silently lacks whatever that panel expects.
The one number shown in the Info tab was the client's, which is never the stale half, so
the mismatch was invisible - the failure mode was "a feature does nothing and there is no
signal why".

## Changes made

### Per-panel session isolation

- `ChatPanel` gets a `panelId = crypto.randomUUID()`, constant for the panel's lifetime,
  passed as `?panel=<uuid>` in the WS URL.
- `SessionEntry.owner` records it. `addClient(ws, fresh, sessionId, panelId)`:
  - a **known** owner rejoins that entry (webview reload, daemon restart),
  - an **unknown** one creates a fresh entry - never the channel default.
- A rejoin returns `true`, like a deep-link attach, because the replay must be deferred
  to `webviewReady` (the socket opens while the React bundle is still evaluating, so an
  immediate replay lands before `App` registers its `message` listener and is lost).
  `session.ts` splits the two cases: `liveAttach = attached && !!hooks.sessionId` vs
  `panelRejoin = attached && !hooks.sessionId`.
- `moveToNewSession` **transfers** `owner` to the new entry, so a later reconnect rejoins
  the new session instead of the abandoned one.
- `replayHistory` now returns `false` when the entry has neither history nor a snapshot,
  and callers fall back to `loadSession` from disk. Needed because an entry can be *bound*
  to a session it never streamed (a finished session opened by deep link is filled from
  disk), and replaying its empty history would blank the client's view.

### Session + version rows in the Info tab

- `serverInfo` carries `sessionId`, `sessionPath` (`sessionFilePath()` in `sessions.ts`),
  and `serverVersion`.
- `readServerVersion()` extracted to `src/backend/version.ts` and reused by both
  `session.ts` and `daemon.ts` (which had its own private copy for the discovery file).
  It reads the `package.json` **above the compiled output**, so a daemon launched from an
  installed extension folder reports *that* install's version rather than whatever is
  checked out elsewhere on the machine.
- Info tab shows **Client** (this UI build) and **Server** (the serving daemon). On a real
  mismatch the Server row renders `<v> (stale)` in `.infoValueWarn` with an explanatory
  tooltip; a daemon too old to send the field at all renders `unknown (stale)`, since
  silence is itself proof of skew there. Skew is only flagged when the client version is
  known, so the browser dev host (which passes none) never shows a false warning.
- `sessionId` was added to `SESSION_STREAM_EVENTS`: a browsing client is viewing another
  transcript and must not have its address bar rewritten to the live one.

## Files changed

| File | Change |
|------|--------|
| `src/backend/version.ts` | new - `readServerVersion()` |
| `src/backend/daemon.ts` | drop private `readVersion()`, use the shared helper |
| `src/backend/channel.ts` | `SessionEntry.owner`, `panelId` in `addClient`, owner transfer in `moveToNewSession`, `replayHistory` -> `boolean`, `sessionId` gated |
| `src/backend/session.ts` | `serverVersion` in `serverInfo`; `liveAttach` vs `panelRejoin` split |
| `src/frontend/chat/ChatPanel.ts` | `panelId`, `?panel=` in the WS URL |
| `webview/src/components/SettingsModal.tsx` / `.module.css` | Client/Server rows, `versionSkew` / `serverUnknown`, `.infoValueWarn` |
| `e2e/panel-isolation-integration.spec.ts` | new |
| `e2e/session-info-integration.spec.ts` | new (session id + transcript path + server version) |
| `e2e/session-deep-link-integration.spec.ts` | reload of a finished deep link replays again |

## Gotchas

- **A rejoin cannot replay at attach time.** The obvious shape (replay inside
  `addClient`) loses the payload: the WS opens during React module evaluation, before any
  `message` listener exists. Both the deep-link attach and the panel rejoin therefore
  return `true` and let `webviewReady` drive the replay - the return value means "defer",
  not "attached to something live".
- **"Bound to a session" is not "has history for it".** A finished deep link binds the
  entry and fills the client from disk, so the entry's in-memory history stays empty; the
  first version of the reload path replayed that emptiness and produced a blank page.
- **Version skew must not fire on unknown halves.** Treating a missing `serverVersion` as
  a mismatch unconditionally lights the warning up in browser dev mode, where the client
  version is absent by design. The guard is `!!version && ...` on both branches.

## Verification

`yarn compile`, `yarn build`, then:

```
npx playwright test e2e/session-info-integration.spec.ts --project=integration --no-deps
```

2 passed (~15s). See [common/e2e-testing.md](../../common/e2e-testing.md) for the
integration-tier rules (single 90s project timeout, `workers: 1`, no per-test
`setTimeout`).

## Remaining work

- Nothing outstanding for these two changes; the working tree is not yet committed.
- Still open in the parent plan: `handleResumeSession` attach-first and the channel-wide
  `liveIds` discovery field (see [multi-device-live-session](../../plans/multi-device-live-session.md)).
