# Calling a rate-limited external API from a server with many clients

The Anthropic usage and models endpoints rate-limit hard (HTTP 429), and Argus serves an
unbounded number of panels from one process. Every feature that reads such an endpoint has
converged on the same shape; this is that shape, so the next one does not rediscover it.

## One module owns the call

A client must never trigger an API call one-for-one. `usagePoller.ts` is the only module that
calls `fetchUsage`, and `session.ts` deliberately does **not** import it - the invariant is
greppable, and a handler cannot quietly reintroduce a per-client fetch:

```ts
// No fetchUsage here on purpose: usagePoller.ts is the only caller of the usage API,
// so the per-process rate floor cannot be bypassed by a client-triggered handler.
import { fetchAccountInfo, fetchModels } from './accountUsage';
```

Clients *ask*: `getAccountUsage` / `getUsageLimits` call `requestUsageRefresh()`, which answers
from the shared snapshot, joins a request already in flight, or spends the one request the
process is allowed. Opening a modal and clicking its refresh button in five panels is one
request, not five.

## The floor is measured from the last attempt, not the last success

This is the part that is easy to get backwards, and both features in this repo learned it the
same way:

- **Usage** (`USAGE_MIN_REFRESH_MS`, 60s): during a 429 there *is* no success to measure from, so
  a success-based floor lets a user clicking refresh retry on every click and deepen the limit
  they are waiting out.
- **Model data** (`modelDataUpdatedAt` + `modelDataAttemptedAt`, 24h / 1h): a failed fetch must
  not stamp the success clock, or a stale 200k context window hides for a day; but without an
  attempt clock a permanently broken environment re-attempts on every daemon start. See
  [../tasks/model-refresh-retry-backoff/notes.md](../tasks/model-refresh-retry-backoff/notes.md).

Two clocks, or one attempt clock plus a snapshot timestamp for display. Never one success clock.

## Failure keeps the last good data

An empty result is a failed fetch, not new information. Server-side the snapshot is retained and
only the reason is recorded; client-side the same rule applies, and it has to be stated explicitly
because the obvious `setState(payload.windows)` silently violates it - a reconnect landing on a 429
then blanks a healthy indicator. Both sides of the wire follow "keep what you have, record why".

Corollary: the reply is sent **even when the fetch failed** (empty list plus a string `error`), so
one request always yields one reply and the UI can distinguish "unavailable" from "still loading"
(see [ui-that-reads-as-broken.md](ui-that-reads-as-broken.md)).

## Fan the result out

Whatever the one caller fetches is broadcast to every client (`broadcastToAllChannels`), skipped
when the payload is unchanged. This is what makes the single-caller rule invisible to the user:
one person's refresh updates everyone's view, and no panel has a private copy that can drift.

Anything else that happens to fetch the same data must publish into the same snapshot rather than
keep its own - the Account & Usage modal did keep its own briefly, and the modal and the header
indicator showed different numbers side by side.

## Give it an env kill switch

The e2e suite runs the server too. Without `ARGUS_USAGE_POLL=0` in both
`playwright.config.ts`'s `webServer.env` and `e2e/daemonHelpers.ts`, a day of runs rate-limits the
account and then every API-dependent spec skips - which is how this was learned. See
[e2e-testing.md](e2e-testing.md).

## Where this lives

`src/backend/usagePoller.ts` (usage), `src/backend/modelData.ts` (model data), endpoint specifics
in [oauth-usage-api.md](oauth-usage-api.md) and [model-context-windows.md](model-context-windows.md).
