# Fix: version skew warning always blamed the Server row

**Status:** committed and pushed (2026-08-04, `83f1b4f`)
**Related:** [panel-isolation-and-session-info](../panel-isolation-and-session-info/notes.md) (introduced the Client/Server rows)

## Problem

Reported via screenshot: Settings > Info showed `Client 0.0.79` / `Server 0.0.80
(stale)`, with a tooltip telling the user to restart the daemon. But 0.0.80 >
0.0.79 - the daemon was newer, not stale; the panel's own build was the one behind.

Root cause in `SettingsModal.tsx`: `versionSkew` was a plain inequality
(`version !== serverVersion`) with no direction, so the Server row always got
`(stale)` + the "restart the daemon" tooltip whenever the two differed, even when
the daemon was actually ahead. That's actively wrong advice in that case (the
daemon doesn't need restarting; the client build does).

## Changes made

- Added `compareVersions(a, b)`: numeric per-dot-segment compare (a plain string
  compare also gets `"0.0.9"` sorting after `"0.0.10"` wrong, which would misfire
  in the same way).
- Replaced `versionSkew` with `versionCompare` + two direction-aware flags:
  `serverIsStale` (daemon behind) and `clientIsStale` (this build behind).
- Client row now gets `.infoValueWarn` + `(stale)` + a tooltip pointing at
  updating/reloading the install when `clientIsStale`.
- Server row keeps the original `(stale)` + "restart the daemon" treatment, but
  now only when `serverIsStale` is actually true.
- `serverUnknown` (daemon too old to report a version at all) is unchanged - it's
  inherently the daemon's fault since the field simply doesn't exist yet.

## Files changed

| File | Change |
|------|--------|
| `webview/src/components/SettingsModal.tsx` | `compareVersions`, `versionCompare`/`serverIsStale`/`clientIsStale`, Client row warning styling |
| `e2e/version-skew.spec.ts` | new (mock) - both skew directions, numeric-vs-lexicographic segment compare, matching-version no-op |

## Verification

Browser (manual, via mock `workspaceInfo`/`serverInfo` dispatch): confirmed both
directions render correctly - screenshots in `scripts/after-fix-client-stale.png`
and `scripts/after-fix-server-stale.png`.

```
npx playwright test e2e/version-skew.spec.ts --project=mock
npx playwright test e2e/session-info-integration.spec.ts --project=integration --no-deps
```

4 passed (mock), 2 passed (integration, pre-existing equal-version case unaffected).

## Follow-up (2026-09-03): the same clobber on the other row

The spec went red again at version 0.0.91:
`expected "0.0.79 (stale)", received "0.0.91"`.

The `beforeEach` drops `getServerInfo` because its real reply overwrites the mocked
**server** version. The identical hole was still open on the **client** row and went
unnoticed for ten versions: the client version is injected as a `workspaceInfo` message,
and `getInfo` was never dropped, so the backend's real reply (this build's actual version)
won whenever it landed last. Timing decided which, which is why it survived until the
numbers diverged - exactly what this file's own comment predicted.

Observed rather than inferred, by logging every inbound `workspaceInfo`:

```
after load : version 0.0.91   (reply to the app's own getInfo on mount)
injected   : version 0.0.79
+330ms     : version 0.0.91   (reply to an explicit getInfo)
```

Fix: drop both types in the init script (`DROP = { getServerInfo: true, getInfo: true }`).

| Throwaway probe | Client row after 1.5s |
|---|---|
| without the drop | **0.0.91** - the reported failure, reproduced |
| with the drop | **0.0.79** |

**Near-miss worth keeping:** the first probe asserted `toContainText('0.0.79')` immediately
after triggering the fetch and **passed**, because `toContainText` matches on its first poll
and stops - before the real reply landed 330ms later. It "proved" the clobber did not exist.
An assertion meant to catch a *later* overwrite has to wait, then read once. Generalised in
[../../common/e2e-testing.md](../../common/e2e-testing.md).

## Remaining work

None. Original fix committed and pushed as `83f1b4f`; the `getInfo` follow-up is uncommitted
(see [../dir-preview/notes.md](../dir-preview/notes.md) for the session it came from).
