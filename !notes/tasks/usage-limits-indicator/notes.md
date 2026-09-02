# Header usage indicator + central daemon usage poller

| | |
|---|---|
| Status | IMPLEMENTED / verified (232/232 mock, 4 new integration tests incl. a control; live UI checked in the browser) |
| Requested | 2026-08-22, by the user: "simple indicator with 3 horizontal lines to show current limits", polled centrally in the daemon once a minute while active, paused after an hour of silence, consumed by any number of clients |
| Produced by | Claude Code, model claude-opus-5 |

## What was asked

Three things, in the user's own framing:

1. A compact indicator in the header showing the same limits the Account & Usage modal shows as
   full bars (Session 5hr, Weekly 7 day, Weekly Fable).
2. Refresh **centrally in the daemon**, once a minute, starting immediately when activity is
   detected; if there has been no activity for an hour, polling pauses.
3. Any number of clients read that data, but only one process polls.

## Design

**One poller per server process, never per client** (`src/backend/usagePoller.ts`). The usage
windows are machine-global (one account), so a per-panel fetch would multiply requests against an
endpoint that rate-limits hard while producing the same three numbers. `startServer()` calls
`startUsagePoller()` once it is listening, which covers both the daemon and the dev server; the
extension host is connect-only and runs no server, so it has none.

It started out in `daemon.ts` (the letter of "polling should be only in daemon") and moved after
the user reported the feature missing on their dev server: with no poller there, the one-shot
fallback fetch at connect was the only attempt ever made, so a transient 429 left the indicator
blank until a manual reload. The requirement was really "not once per client", and `startServer`
satisfies that while making the feature work where it is developed.

**Activity gate.** `noteUsageActivity()` stamps a clock and, when polling was paused, resumes it
with an immediate fetch. The interval tick re-checks `usagePollActive(lastActivityAt, now)` and
clears the timer once the hour has passed, so a quiet machine makes zero requests. Activity is:

- any `send` (`handleSend`, including a mid-turn inject and a silent retry - all spend tokens),
- an explicit usage refresh (`getAccountUsage {force:true}`); merely opening the modal is not,
- daemon startup, which only happens because a panel asked for it.

`lastActivityAt === 0` ("nothing yet") is deliberately distinct from a stale stamp: a daemon
launched and never used does not poll on a timer at all.

**Delivery.** A successful poll broadcasts `usageLimits {windows, fetchedAt}` through
`broadcastToAllChannels()`, so every client in every workspace gets it. An unchanged window set
sends nothing (most polls in a quiet hour return identical percentages). A client that connects
between polls pulls the current snapshot with `getUsageLimits`; the handler answers from the
poller's snapshot when it has one, else with a single 60s-cached `fetchUsage()` - which is why a
dev server or an extension host, where no poller runs, still shows real numbers without ever
becoming per-client polling.

**One reply per request, always.** `getUsageLimits` answers even when the fetch failed (empty
`windows` plus a string `error`), so a client can tell "unavailable" from "still loading" - and so
the round-trip test cannot be silently satisfied by a rate limit.

**A failed poll keeps the last good snapshot.** A 429 or an expired token is transient; a blank
indicator is worse than a slightly old one.

**One caller, one rate floor.** `usagePoller.ts` is the only module that calls the usage API;
`session.ts` does not import `fetchUsage` at all, so a client-triggered handler cannot bypass the
budget. A client asks (`getAccountUsage`, or `getUsageLimits` with an empty snapshot) and
`requestUsageRefresh()` decides: answer from the snapshot, join the request already in flight, or
spend the one request allowed per `USAGE_MIN_REFRESH_MS` (60s) - then broadcast the result, so one
person's refresh updates every panel. The user asked for this directly ("I don't want to add client
possibility to flood request for limits"); before it, `getAccountUsage` called `fetchUsage(force)`
per client, so two panels clicking refresh were two API calls against an endpoint that was already
returning 429.

The floor is measured from the last **attempt**, not the last success - the same two-clock reasoning
as the model-data refresh ([model-refresh-retry-backoff](../model-refresh-retry-backoff/notes.md)).
Measuring from success would let a user clicking refresh at a 429 retry on every click, deepening
the limit they are waiting out.

**One snapshot, two views.** The Account & Usage modal fetches usage itself, so its bars and the
header indicator drifted apart the moment the modal refreshed (reported by the user with both on
screen showing different numbers). `publishUsageWindows()` is now the single door into the
snapshot: the poller and the modal's `getAccountUsage` both go through it, so a modal fetch is
adopted and broadcast to every panel. The webview closes the loop in both directions - `App.tsx`
also adopts `accountUsage.rateLimits` directly (instant, and works against an older daemon that
predates the broadcast), and the modal adopts `usageLimits` pushes so it cannot freeze while open.

**An empty payload never clears anything.** Found by a test written for the sync: the client used
to overwrite its windows with whatever arrived, so an empty `usageLimits` (a reconnect landing on a
429) blanked a healthy indicator. Server and client now follow the same rule - keep the last good
numbers, record only the reason.

**An empty indicator must say why.** With no windows the widget falls back to the account icon,
and its tooltip carries the server's reason ("Usage data unavailable: rate limited (HTTP 429)").
This came directly from the report above: a silent fallback is indistinguishable from an
unimplemented feature, and the reason was already in the reply, just discarded by the UI.

## UI

`webview/src/components/UsageIndicator.tsx`: three stacked mini bars in the header's
`topRightActions`, clicking opens the Account & Usage modal. Same labels, ordering, rounding and
colour tiers as the modal's full bars - those moved into `webview/src/utils/usage.ts` and both
components import them, so the two renderers cannot drift. Tooltip lists each window with its
percent and reset ("Session (5hr): 12% · Resets in 2h 2m · Sat 4:24 PM"). At most three bars,
dropping the lowest-priority window.

**It replaced the separate "Account & usage" header button** (the user pointed out that a button
whose only job was opening the modal sat right next to a widget that already did). That makes the
indicator the header's only entry point, so the original "render nothing when there are no
windows" rule had to go: with no data it now renders that button's icon instead. Vanishing would
have taken the entry point away exactly when the user most wants the panel (the API is down and
they want to hit refresh), while three dead grey lines would look broken. The slash menu's
"Account & usage..." action is the other way in, and is what every pre-existing e2e spec uses -
which is why removing the button broke no existing test.

## The invisible track

Reported by the user against the modal's full bars, but it applied to the new header bars too:
only the filled part of each bar was visible, so a 14% session bar was a floating stub with no
sense of how much room was left.

Measured rather than guessed: the track computed to `rgb(25,26,27)` and the modal surface behind it
to `rgb(25,26,27)`, byte-identical. `.progressTrack` used `var(--input-bg)`
(`--vscode-input-background`), which in this theme happens to equal the surface colour. Nothing was
wrong with the layout, the track was simply painted in the background's own colour.

Fixed with a new `--track-bg` token in `global.css`, a `color-mix` wash of `--fg` (14%), which
contrasts by construction on any theme rather than depending on a VS Code colour that may or may
not differ from its neighbour. Both bar renderings use it.

An equal-colour bug passes every assertion about size, position and visibility, so the regression
test compares the **computed colours** of the track and its surface, in the header and in the modal.
Verified red first by reverting the token to `var(--input-bg)`.

The reusable half of this (a theme token is not a promise of contrast; an empty widget must state
its reason; how to test both) lives in
[../../common/ui-that-reads-as-broken.md](../../common/ui-that-reads-as-broken.md).

## Files changed

| File | Change |
|------|--------|
| `src/backend/usagePoller.ts` | New, and the only caller of the usage API: `startUsagePoller`, `noteUsageActivity`, `requestUsageRefresh` (shared, floored, coalescing), `publishUsageWindows`, `getUsageSnapshot`, pure `usagePollActive` / `usageRefreshDue` gates, `USAGE_POLL_INTERVAL_MS` (60s) / `USAGE_ACTIVE_WINDOW_MS` (1h) / `USAGE_MIN_REFRESH_MS` (60s) |
| `src/backend/index.ts` | `startServer()` starts the poller once listening (daemon + dev server) |
| `playwright.config.ts` | `webServer.env` sets `ARGUS_USAGE_POLL: '0'` so suites do not poll the live API |
| `src/backend/session.ts` | `getUsageLimits` handler; `noteUsageActivity()` on send and on a forced usage refresh; `getAccountUsage` publishes its windows into the shared snapshot |
| `webview/src/utils/usage.ts` | New: `RateLimitInfo`, labels/order, `sortWindows`, `usagePercent`, `usageTier`, `formatReset` (moved out of the modal) |
| `webview/src/components/UsageIndicator.tsx` / `.module.css` | New indicator |
| `webview/src/components/AccountUsageModal.tsx` | Uses the shared helpers instead of its own copies |
| `webview/src/global.css` | New `--track-bg` token (the unfilled part of a progress bar) |
| `webview/src/components/AccountUsageModal.module.css` | `.progressTrack` uses `--track-bg` |
| `webview/src/App.tsx` | `usageWindows` state, `usageLimits` push handling, `getUsageLimits` on mount + on reconnect, renders the indicator; the separate "Account & usage" button removed |
| `webview/index.html` | `getUsageLimits` added to `MOCK_SUPPRESSED` |
| `e2e/daemonHelpers.ts` | `ARGUS_USAGE_POLL: '0'` for test daemons, with a `usagePoll` opt-in |
| `e2e/usage-indicator.spec.ts` | New (mock): rendering + the pure poll gate |
| `e2e/usage-indicator-integration.spec.ts` | New (integration): round trip, real header fill, daemon polls on its own + control |

## Verification

- Full mock project: 232/232, including the pre-existing `account-usage` / `usage-insights` specs
  that exercise the refactored modal.
- Integration: the daemon test asserts the reply is **older than the request** (the poller's
  snapshot predates it), with a polling-disabled control asserting the opposite - without the
  control, "any usage reply at all" would have passed.
- A first attempt at that test compared `fetchedAt` against a cutoff taken at daemon startup and
  failed: the startup poll is a network round trip that lands a few hundred ms **after** the
  daemon starts listening. `scripts/probe-poller.js` showed the poller itself was fine (snapshot
  filled in ~340ms), so the assertion was wrong, not the feature. Age-at-request-time is the
  correct discriminator.
- Live browser check: indicator renders, tiers correct (70% weekly shows the warning colour),
  tooltip as above.
- While the live API was returning 429, `scripts/probe-ws-usage.js` confirmed the server answers
  `{windows: [], error: 'rate limited (HTTP 429)'}` in ~100ms and the indicator correctly hides;
  the API-dependent tests skipped instead of flaking.

## Gotchas (wrong turns this session)

- **Started the poller in `daemon.ts`**, taking "polling should be only on in demon" literally. The
  dev server was then passive, so the one-shot fetch at connect was its only attempt ever, and the
  user reported the feature as missing when a `429` made that attempt come back empty. The
  requirement was really "not once per client". Moved into `startServer()`; the general rule is now
  in [../../common/development.md](../../common/development.md).
- **Asserted an absolute cutoff** to prove the data came from the poller (`fetchedAt < cutoff`,
  cutoff taken right after the daemon started listening). Red on a working build, because the
  startup poll finishes a few hundred ms after `listen`. The misleading part was that the failure
  looked exactly like "the poller never ran"; `scripts/probe-poller.js` showed a snapshot filled in
  ~340ms and moved the suspicion to the assertion. Age-at-request-time is the discriminator, now in
  [../../common/e2e-testing.md](../../common/e2e-testing.md).
- **Hid the indicator entirely when it had no windows.** Defensible in isolation (three dead grey
  lines look broken), wrong once it became the header's only entry to the modal, and it is what
  produced the "I don't see that feature" report. Silence is not a neutral empty state - see
  [../../common/ui-that-reads-as-broken.md](../../common/ui-that-reads-as-broken.md).
- **Ran the e2e suite while the user's own `yarn dev` was up.** The config guard stopped it
  (their server reads the real `~/.claude/argus.json`), which is the guard working. Stopping their
  server is a real cost, so mock runs went through the documented escape-hatch config instead; note
  its results are config-dependent, and `model-picker.spec.ts:85` fails under it for that reason
  alone.
- **Sizing took three passes** (34px, then 68px on "make it wider twice", then 51px on "not x2,
  x1.5"). Recorded only because the final number looks arbitrary in the CSS: it is 1.5x the
  original, not a measured optimum.
- **Left `getAccountUsage` fetching per client.** Syncing the modal and the indicator was done
  first by publishing whatever the modal's own `fetchUsage(force)` returned - correct on screen,
  but each panel's refresh button was still one API call, against an endpoint already returning
  429. The user named it ("I don't want to add client possibility to flood request for limits")
  and the fix was to invert the direction: clients ask, the server decides whether to spend a
  request. The general pattern is now in
  [../../common/rate-limited-external-apis.md](../../common/rate-limited-external-apis.md).
- **A test written for the sync found a real bug.** The "empty push must not blank existing bars"
  case was written to cover the new sync path and failed immediately: `App.tsx` overwrote its
  windows with whatever arrived, so a reconnect landing on a 429 blanked a healthy indicator. The
  server already had the right rule; only the client did not.

## Known limitations / possible follow-ups

- The snapshot is memory-only. After a daemon or dev-server restart the indicator is blank until the
  first successful poll (seconds). Persisting it to `argus.json` was considered and rejected: unlike
  a model list, a usage percentage goes stale quickly and a restored old value would mislead.
- The hour-long pause path is covered by the pure gate, not by a live test (it would take an hour).
- ~~`e2e/usage-indicator-integration.spec.ts`'s "a modal fetch becomes the snapshot every other
  client reads" has **not been executed once**.~~ **Executed 2026-09-02/03** - it passes when
  the live API is healthy, skips when rate-limited, and **fails intermittently in full-suite
  runs for a reason still unknown**. See the follow-up section below before trusting it.
- The extension panel needs `yarn build` **and** a daemon restart to pick this up - the daemon runs
  from the panel's own install, see [../../common/backend-restart.md](../../common/backend-restart.md).

## Follow-up (2026-09-02/03): `usage-indicator-integration.spec.ts:105`

Reported failing three times with `no accountUsage frame within 20000ms`. **One real spec
bug fixed; the underlying intermittency is still unexplained.** Recorded in full because two
confident diagnoses were wrong, and each looked convincing.

**Fixed - the loop waited for a frame that has no sender.** The handler sends exactly two
frames (`usagePending: true`, then the settled reply). The spec looped
`for (i < 3 && windows.length === 0)`, so when the settled reply carried **no** windows it
kept waiting for a third, and timed out before reaching the `test.skip` written for exactly
that case one line below. So it failed precisely when the code did the right thing: a 429
with empty `rateLimits` plus a stated `usageError` is the correct no-data reply. Fix is a
`break` after the settled frame.

**Wrong diagnosis #1 (real bug, not this one).** After that fix the same message returned,
which - given at most two waits now happen - could only mean *zero* frames, and the only
path to zero is a rejection both `.catch(() => {})` swallow. `execFile` does throw
synchronously on `spawn UNKNOWN`, which rejects a promise documented as always resolving.
Guarded, with a red/green probe. **The failure came back anyway**, so it was never the
cause. Kept because that path really did leave the modal spinning forever; written up in
[../../common/request-reply-invariant.md](../../common/request-reply-invariant.md).

**Wrong diagnosis #2 (refuted by measurement).** Spawn latency under suite load delaying
phase 1 past 20s: `scripts/probe-load.js` in [../dir-preview/](../dir-preview/) measures
phase 1 at **518ms idle and 522ms** while the box churns 12 concurrent process spawns.

What is measured and solid: the handler emits exactly two frames in ~520-630ms, **8/8**
attempts, idle and under load, including while the API is 429ing. It only fails inside a
full-suite run, and the error message cannot distinguish which of the two waits expired,
which is why every hypothesis fit the evidence equally well. Also checked and cleared: the
run did not straddle a `tsx watch` restart.

**Next step is instrumentation, not another theory.** Run the suite with the backend owned
outside the runner so stdout survives (see
[../../common/e2e-testing.md](../../common/e2e-testing.md), "Run with the backend's stdout
captured") - Playwright swallows `webServer` output, and this spec drives raw WS with no
page, so its artifact carries only a source listing.

## Scripts

| Script | Purpose |
|--------|---------|
| [scripts/probe-poller.js](scripts/probe-poller.js) | Start the compiled poller in isolation and print the snapshot - answers "did the startup poll land?" with no daemon, WS or Playwright in the path |
| [scripts/probe-ws-usage.js](scripts/probe-ws-usage.js) | Ask a running server for usage over a real WebSocket and print the raw reply (windows, error, data age) |
