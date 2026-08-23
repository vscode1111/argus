# A failed model-data refresh hid a stale context window for a full day

| | |
|---|---|
| Status | FIXED / verified (red reproduced by mutation, green passes, full mock suite 221/221) |
| Reported | 2026-08-22, by the user, asking whether the daemon's periodic refresh actually keeps the context percentage correct |
| Produced by | Claude Code, model claude-opus-5 |

## Problem

The context-usage pill is `input tokens / the model's own window`, and the window comes from
`contextWindowFor()`, which reads `modelListCache` in `argus.json`. That cache is filled by the
daemon's daily refresh. So the pill is only as correct as the last successful refresh.

`refreshModelData()` stamped the success clock unconditionally:

```ts
const next = { ...cfg, modelDataUpdatedAt: Date.now() };   // before the result is examined
...
if (models.length > 0) next.modelListCache = models;       // cache itself was guarded
```

The cache guard was right (a failed fetch never blanked the windows), but the timestamp advanced
even when `fetchModels()` returned `{ models: [], error }`, which is what it returns for an
expired OAuth token, a missing token, and any network error. The next attempt was then a full
day away.

Consequence: a model absent from the cache falls back to `DEFAULT_CONTEXT_WINDOW` (200k). On a
1M model that is a percentage **five times too high**, and it would persist for 24h even though
the machine came back online a minute later.

## This was a deliberate tradeoff, not an oversight

The original code carried a comment saying so:

> `modelDataUpdatedAt` is stamped regardless so a broken environment retries daily instead of on
> every start.

That protection is real. If a failure left the success clock untouched, the data would be
permanently stale, so **every** daemon start would re-attempt, and each attempt spawns a real CLI
turn (`detectDefaultModel`, up to a 60s timeout). The daemon idle-exits after 10 minutes and
respawns whenever a panel opens, so that is potentially dozens of CLI turns a day.

So the old behavior bought respawn protection by paying up to a day of a possibly wrong
percentage. The fix gets both instead of choosing.

## Fix: two clocks

| Clock | Advances | Gate |
|---|---|---|
| `modelDataUpdatedAt` | only when a model list actually came back | 24h |
| `modelDataAttemptedAt` (new) | on every attempt, success or failure | 1h |

`shouldRefreshModelData()` requires **both** gates open. The attempt clock is what makes it safe
for a failure to leave the success clock alone: a permanently broken environment is stale
forever, but it still cannot re-attempt more than once an hour, and a daemon respawn inside that
hour does nothing.

Both halves were extracted as **pure functions** taking the config as an argument
(`shouldRefreshModelData`, `applyRefreshResult`), which is what made them testable at all: the
real refresh does a network call plus a CLI spawn, and neither belongs in a test.

The asymmetry inside `applyRefreshResult` is the whole fix: `modelDataAttemptedAt` always
advances, `modelDataUpdatedAt` only under `models.length > 0`. A partial success does not count
either, so detecting a default model while the fetch failed still leaves the success clock alone
(the model list is the only input `contextWindowFor` reads).

## Files changed

- `src/backend/config.ts` - new `modelDataAttemptedAt` field plus a rewritten comment on
  `modelDataUpdatedAt` explaining that only a real fetch advances it.
- `src/backend/modelData.ts` - `MODEL_DATA_RETRY_MS`, `RefreshClock`, `shouldRefreshModelData()`,
  `applyRefreshResult()`; `refreshModelData()` and `scheduleModelDataRefresh()` rewired to them;
  a log line when the fetch returns nothing.
- `e2e/model-data-refresh.spec.ts` - new, 10 tests.
- `CLAUDE.md` - `modelData.ts` structure entry, the "Daily refresh" paragraph, the e2e listing.

## Verification

Evidence that the live chain works, gathered before changing anything (this is what the user
actually asked):

```
modelDataUpdatedAt: 0.9h ago      daemonLastStartAt: 1.9h ago
modelListCache    : 10 entries, all with real windows
claude-opus-5     -> 1000000  (REAL cache hit, not the fallback)
```

The observed `21%` pill therefore meant ~210k input against a 1M window, which is correct. Note
the refresh fired about an hour **after** the daemon start, not at start: at launch the data was
still under 24h old so the gate skipped it, and the hourly re-check caught it once it crossed.

Test runs:

- **Red by mutation.** The fix *creates* the functions under test, so there was no prior API to
  run red against. Instead `applyRefreshResult` was temporarily reverted to the unconditional
  stamp: **3 failed, 7 passed**, and the 3 were exactly the persistence tests. The scheduling
  tests stayed green, correctly, since they do not depend on that function. That localisation is
  what makes the red meaningful.
- **Green:** 10/10 after restoring, with the mutation marker count asserted at 0.
- **Full mock suite:** 221 passed, 0 failed.
- **`daemon-lifecycle-integration.spec.ts`:** 6 passed (it is the only other spec asserting on
  these timestamps, via the `ARGUS_MODEL_REFRESH=0` kill switch).
- `tsc -p ./` clean. Webview `tsc` still shows only the pre-existing `SyntaxHighlighter` error in
  the untouched `FileViewerModal.tsx:261`.

Backward compatibility checked against the real config shape, which has no `modelDataAttemptedAt`
yet: `readConfig()` merges `DEFAULT_CONFIG` and the gate uses `|| 0`, so a pre-upgrade config
reports `false` while fresh and `true` once a day passes. Nothing to migrate.

## Gotchas

### The test was first put in the wrong Playwright project

It was named `model-data-refresh-integration.spec.ts` out of habit, because it exercises compiled
backend code. Wrong: the `integration` suffix means *drives a real CLI or the real backend*, and
this drives neither. It went to the `mock` project, which is parallel and runs first, instead of
adding load to the serial one-worker suite. Generalised into
[../../common/e2e-testing.md](../../common/e2e-testing.md).

### These pure functions need no child process

Nearby specs (`context-window-integration`, `workspace-info-config-integration`) run their
assertions in a child process, because the functions they test read `ARGUS_CONFIG`, which
`config.ts` resolves at **import** time. `shouldRefreshModelData` and `applyRefreshResult` take
the config as an argument, so they have no such coupling and are called directly. Copying the
child-process ceremony would have been cargo cult.

## Remaining work

- Committed in `38c1d39` (2026-08-24), together with the header usage indicator.
- `modelDataAttemptedAt` is in `DEFAULT_CONFIG`, so like every other field there it is reachable
  through `updateSettings`. Consistent with the existing `modelDataUpdatedAt` / `modelListCache` /
  `daemonLastStartAt`, and `updateSettings` is only reachable over an already-authorized
  connection, so this adds no new exposure. Worth revisiting only if the allowlist is ever split
  into user-settable versus machine-owned fields, which would be the real fix.
- The 1h retry is a constant, not backoff. An environment broken for a week performs ~24 pointless
  attempts a day, each spawning a CLI turn. Bounded and far better than the previous
  every-respawn behavior, but exponential backoff up to the 24h ceiling would be strictly better
  if that ever shows up in practice.
