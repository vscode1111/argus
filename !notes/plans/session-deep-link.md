# Session deep link (`?session=<id>` in the URL)

**Status:** implemented (2026-07-24, working tree)
**Created:** 2026-07-22
**Depends on:** [multi-device-live-session](multi-device-live-session.md) - attach-by-sessionId must exist first; without it a deep link can only replay from disk. *The connect-time subset of that plan was implemented as part of this work* (`channel.addClient(ws, fresh, sessionId)` live-attaches; `handleResumeSession` attach-first and `liveIds` discovery remain open there).

## Implementation notes (deviations from the plan below)

- **Replay is deferred to `webviewReady`, not sent at upgrade.** The socket *joins* the right entry at upgrade (that part must happen before any other message), but the WS opens while the React bundle is still evaluating, so a replay pushed at upgrade can be dispatched before `App` registers its `message` listener and be silently lost. On `webviewReady` the server checks the actual runtime state (`s.currentProc && !s.cliDone && s.sessionId === hooks.sessionId`) to determine whether the entry is live; if so it calls `channel.replayHistory(ws)` (entry history + streaming snapshot), otherwise it falls back to `loadSession` -> `sessionLoaded` from disk.
- Disk-fallback sets `s.sessionId = id` only on an idle entry (`!currentProc`) so a mid-turn resume pointer is never clobbered.
- The shims keep the `session` variable in step with navigation: cleared on `switchWorkspace` and `newSession`, updated on `resumeSession`, so a WS reconnect re-attaches to what the user is actually viewing. The browser URL is synced via `history.replaceState()` on each change (`updateUrl()` helper), so the address bar always shows the correct deep link (or falls back to `?dir=` alone when there's no active session).
- Copy-link button on Session History rows is browser-mode only (`!isVsCode`; a `vscode-webview:` origin would make a useless URL) and copies the robust `<origin>/?session=<id>` form; clipboard API with a textarea fallback (plain-http LAN pages are not a secure context).
- e2e went into a dedicated `e2e/session-deep-link-integration.spec.ts` (not `shared-channel-integration.spec.ts`): live attach + remote stop, no-dir workspace resolution + disk replay of a synthetic transcript, stale-dir override, malformed-id fallback.

## Goal

Make a session addressable by URL, so it can be opened directly on another device:

```
http://10.35.4.120:5173/?dir=D:\_Projects\scub111g\argus&session=<sessionId>
http://10.35.4.120:5173/?session=<sessionId>            # robust form, dir resolved server-side
```

**Send yourself the link, open it, you are in the session.** For the phone use case this beats any in-app discovery: no list to scroll, no guessing which row is live.

Side benefit: **a page refresh re-attaches** instead of dropping into a new isolated session, which is the current behaviour and a real annoyance.

## Why attach at upgrade time, not after connect

Attaching at **upgrade time** means `addClient` can put the socket straight into the right `SessionEntry`. The client never renders an empty state and never receives a disk replay that is then corrected - both of which the Session History modal path necessarily does (connect -> fresh entry -> user clicks -> `resumeSession` -> `sessionLoaded`). It also makes `session` a cleaner override of `fresh` than a post-hoc message.

## Plumbing

Symmetric with the existing `dir` param, three small edits:

| Layer | Today | Add |
|-------|-------|-----|
| `webview/index.html:50` / `media/browser.html:69` | `params.get('dir')` | `params.get('session')` |
| same, `nextUrl()` | `p.set('dir', dir)` | `p.set('session', session)` |
| `src/backend/index.ts:214-222` | reads `dir`, `client`, `nonce` | read `session`, resolve workspace, pass to `addClient` |

## Constraints

- **The id does not exist until the CLI has started.** `s.sessionId` is assigned in `cliHandler.ts:55` from the CLI's `system` init event, so a brand-new empty tab has no id to put in a URL. A link can only be minted for a session that has run at least one turn - fine for the "share a running session" case, but the UI must not offer a link before then.
- **Not live -> fall back to disk replay**, consistent with the attach-first/disk-fallback rule of the parent plan. The URL should still work for a finished session; it just opens read-only-ish rather than attached.
- **Validate it.** `sessions.ts` already checks the id against a UUID regex plus path containment; reuse that, do not trust the query string.
- **Drop it on workspace switch.** `switchWorkspace` reassigns `dir` and reconnects (`index.html:79`, `browser.html:96`); the stale `session` must be cleared or the client will try to attach to a session from the previous workspace.
- **Security is unchanged but worth stating.** The id is not an access grant - the nonce and Origin gate still apply - but a URL is shareable, bookmarkable, and lands in browser history. Anyone who can already reach the port can already list sessions, so this adds convenience, not exposure.

## The workspace tile must follow the session

A session belongs to a workspace, so opening one by URL has to repoint the header workspace tile (`WorkspaceMenu`, shows the cwd basename) as well. Today it is driven by `state.workspacePath`, written by `workspaceInfo` from two places:

- `App.tsx:106` - on mount, **optimistically** from `?dir=` in the page URL, before the server says anything.
- `session.ts:203` - from the server as `s.workspaceDir`, on `getInfo`.

Both break for a deep link:

- `?session=<id>` **without** `dir` -> the optimistic dispatch never fires, so the tile shows nothing (or the previous value) until something else corrects it.
- `?dir=<stale>&session=<id>` -> the client confidently renders the **wrong** project name and keeps it, since nothing re-checks the optimistic value. A link copied between machines with different checkout paths hits this immediately.

**Server resolves the workspace from the session id.** This is already possible: `listAllSessions()` recovers each project folder's real cwd from the `cwd` field inside the transcript records, so the id alone is enough to find the workspace. That makes `dir` **optional** in a deep link - `?session=<id>` by itself is the robust form, and it removes the mismatch class entirely.

Required order at upgrade (`src/backend/index.ts:214`): resolve `session -> workspaceDir` **before** `getOrCreateChannel(workspaceDir)`. Resolving after would put the socket in the wrong channel and no later `workspaceInfo` would fix that.

Rules to implement:

1. If `session` is present, the resolved workspace **wins** over `dir` - it is the more specific intent. Log the mismatch rather than failing.
2. After attach, the server **pushes** `workspaceInfo` with the resolved path so the tile updates without the client asking.
3. `App.tsx:106` must not paint a workspace name from `?dir=` when `session` is present and unverified - treat it as provisional (or skip it) so the tile does not flash a wrong name before the server correction arrives.
4. If the id resolves to no known workspace (deleted project folder), fall back to `dir`/cwd and surface it, instead of attaching to an arbitrary channel.

## UI affordance

Add a "copy link" action to the session (header session name, or the Session History row) so the link can actually be sent to the phone. Without it the feature exists but is unreachable in practice.

## e2e coverage to add

1. Deep link: page B opens `?dir=...&session=<id>` of the turn running on page A and receives live chunks **without** any click, with no empty-state flash in between.
2. Deep link to a **finished** session replays from disk and does not attach; deep link with a malformed id is rejected, not passed to the filesystem.
3. Deep link with **no** `dir` (`?session=<id>` only) resolves the workspace server-side: the header tile shows that project's name and the transcript belongs to it.
4. Deep link with a **stale/mismatched** `dir` ends up in the session's real workspace, and the tile never settles on the wrong name.

Follow the stable-assertion rules in [../common/e2e-testing.md](../common/e2e-testing.md): gate on the Stop button, never on tool calls.

## Files likely touched

| File | Change |
|------|--------|
| `webview/index.html`, `media/browser.html` | read `?session=` and forward it into the WS URL; clear it on `switchWorkspace` |
| `src/backend/index.ts` | read `session` at upgrade; resolve it to a workspace **before** `getOrCreateChannel`; pass into `addClient` so the socket joins the right entry immediately |
| `src/backend/sessions.ts` | `findWorkspaceForSession(id)` - reuse the `listAllSessions` cwd recovery to map a session id to its workspace |
| `webview/src/App.tsx` | do not paint the tile optimistically from `?dir=` when an unverified `session` is present; accept the server's `workspaceInfo` correction |
| `webview/src/components/SessionHistoryModal.tsx` | "copy link" action on a session row |
| `e2e/shared-channel-integration.spec.ts` | deep-link attach / disk-fallback / workspace-resolution tests |
