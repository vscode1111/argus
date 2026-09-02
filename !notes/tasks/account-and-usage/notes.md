# Account & Usage panel

Worked on `main` (no ticket). Built an "Account & Usage" modal matching the official Claude Code panel: an account section (auth method, email, organization, plan) and a usage section with per-window progress bars (Session 5hr, Weekly 7day, Weekly Sonnet/Opus), opened from the InputArea slash menu (`/usage` -> "Account & usage...").

## Problem

Reproduce the official panel inside Argus. Two non-obvious parts:
1. Where does the account data come from, and where does the live usage data come from? An earlier (reverted) attempt guessed the data shapes and got them wrong.
2. The usage bars must appear immediately on open (like the official panel), not only after a message is sent.

## Root cause / key discoveries

### Account data: `claude auth status --json`
`fetchAccountInfo()` spawns `claude auth status --json` and reads `{ loggedIn, authMethod, email, orgName, subscriptionType }`. Resolves `{ loggedIn: false }` on any error so the UI shows a logged-out state.

### Usage data: live OAuth usage endpoint (the important find)
The official panel loads all windows up front because it calls a live API, not the stream. See [common/oauth-usage-api.md](../../common/oauth-usage-api.md) for the full reference. In short:
- `GET https://api.anthropic.com/api/oauth/usage`
- Bearer token read at runtime from `~/.claude/.credentials.json` -> `claudeAiOauth.accessToken` (never logged/persisted).
- Header `anthropic-beta: oauth-2025-04-20`.
- Returns one object per window: `{ utilization: <percent 0-100>, resets_at: <ISO|null> }`, plus many internal codename windows we filter out.

### Why usage only appeared after a message (the original bug)
The first version learned usage solely from streamed CLI `rate_limit_event` frames, which the CLI emits **only while making a request**. So nothing showed until the first message. Fixed by making the live API the primary source, with the stream events as a fallback.

## Changes made

1. **`src/backend/accountUsage.ts`** (new) - `fetchAccountInfo()`, `fetchUsage(force?)`, `parseUsageResponse()`, `parseRateLimitEvent()` (stream fallback), `KNOWN_USAGE_WINDOWS` allowlist. `fetchUsage` returns `UsageResult { windows, error? }`.
2. **Stream fallback** - `cliHandler.ts` accumulates `rate_limit_event`s into `s.rateLimits` (`Map`, reset per connection); used only when the API returns nothing.
3. **Two-phase reply** - `session.ts` sends the account first (`usagePending: true`) the moment `fetchAccountInfo()` resolves, then account + usage once `fetchUsage()` resolves. The account renders immediately instead of waiting on the slow/rate-limited usage call.
4. **Error surfacing** - `fetchUsage` maps non-OK statuses to a short reason ("rate limited (HTTP 429)", "token expired (HTTP 401)", ...). Forwarded as `usageError` only when there is no fallback data; the modal shows it in the empty-state hint.
5. **60s cache** - `usageCache` in `fetchUsage`, bypassed when `force` is true (manual refresh).
6. **Refresh icon** - beside the "Usage" header; spins + disables while `usageLoading`; posts `getAccountUsage { force: true }`.
7. **Footer link** - "Manage usage on claude.ai" -> `https://claude.ai/new#settings/usage`, opened via both `postMessage({type:'openUrl'})` (extension) and `window.open` (browser dev).

## Files changed

| Path | What |
|------|------|
| `src/backend/accountUsage.ts` | New. Account fetch, live usage fetch + cache + error mapping, stream-event parse, window allowlist |
| `src/backend/session.ts` | Two-phase `getAccountUsage` handler; `force` field on the WS message type |
| `src/backend/cliHandler.ts` | Accumulate `rate_limit_event` into `s.rateLimits` (fallback) |
| `src/backend/sessionState.ts` | `rateLimits: Map<string, RateLimitInfo>` field + init |
| `webview/src/components/AccountUsageModal.tsx` | New. Centered portal modal; `accountLoading`/`usageLoading` split; refresh; error hint |
| `webview/src/components/AccountUsageModal.module.css` | New. Modal shell, progress bars, refresh button + spin keyframe |
| `webview/src/components/InputArea.tsx` | Slash menu "Account & usage..." action under a "Model" header |
| `e2e/account-usage.spec.ts` | New. Mock tests (menu, account rows, bar sorting/percent/color/reset, refresh, 429 hint) |
| `e2e/account-usage-integration.spec.ts` | New. Real account info; usage up front; rendered values match a live `/oauth/usage` fetch within ±2% |
| `CLAUDE.md` | File tree, WS protocol entries, Account & Usage convention bullet |

## Gotchas

- **The usage endpoint rate-limits hard.** Repeated dev probing earns a `429` "Rate limited" (token still valid). This is why `fetchUsage` caches for 60s and the integration value-match test *skips* (does not fail) when the live fetch returns nothing.
- **Two different utilization scales.** The live API gives `utilization` as a plain percent (`18`); streamed `rate_limit_event`s give a `0..1` fraction (`0.18`). `parseUsageResponse` divides the API value by 100 so both normalize to `0..1`; the modal multiplies back by 100.
- **Window filtering must be an allowlist, not a denylist.** The response carries internal codename windows (`tangelo`, `iguana_necktie`, `omelette_promotional`, `seven_day_cowork`, `cinder_cove`, `extra_usage`, ...). `KNOWN_USAGE_WINDOWS` keeps only the four real subscription windows; new codenames would otherwise leak into the UI.
- **`openUrl` does nothing in browser dev mode.** In the real extension, `chat.html` routes `openUrl` (VS_ONLY) to `vscode.env.openExternal`. In browser dev (`index.html`), every `postMessage` goes down the WebSocket, and the server has no `openUrl` handler. Links must also call `window.open` (the login button already did this). In the real webview, `window.open` is blocked so only the extension path fires - no double-open.
- **Transient loading state can't be asserted in a mock test.** Every `getAccountUsage` (mount or refresh) triggers a real server reply (the mock project still runs against the `yarn dev` webServer), which races with `window.dispatchEvent` mock writes. A test asserting the momentary "Loading usage data..." text was removed as flaky; integration + deterministic refresh/error tests cover the rest.
- **`null` windows.** `seven_day_opus` often comes back `null`; the modal omits null/absent windows entirely (no empty "Weekly Opus" row).

## Decisions

- **Live API primary, stream events fallback.** The API loads all windows immediately (matches official UX); stream events only arrive mid-request. Fallback covers offline/expired-token/rate-limited cases.
- **Cache in the backend fetch layer, bypassable by `force`.** Re-opening the panel is cheap; an explicit refresh forces a fresh pull. The endpoint's aggressive rate-limiting makes uncached re-opens risky.
- **Two-phase reply over a single `Promise.all`.** Account info is fast; usage can take up to its 10s timeout. Splitting the reply keeps the account instant.
- **Surface only a short, non-sensitive reason** (HTTP status + plain English), never the token or raw response body.

## Follow-up (2026-09-03): the handler could answer nothing at all

Two defects in the two-phase reply above, both fixed.

**`getAccountUsage` sent zero frames on failure.** Both phases ended in `.catch(() => {})`,
so a rejection left the client with nothing to wait on: the modal sat on "Loading..."
forever with no reason shown, and no timeout to end it. Its neighbours `getUsageLimits` and
`getUsageInsights` already answer on failure. Phase 2 now sends a settled frame carrying the
error.

**`fetchAccountInfo` could reject despite promising not to.** `execFile` throws
*synchronously* when the OS refuses a new process (`spawn UNKNOWN`, errno -4094) - a
different path from the callback's `err` - and a throw inside a promise executor rejects it.
Now guarded with a `try/catch` that resolves `{ loggedIn: false }`, matching the contract the
comment already claimed. Full write-up, including the probe that has to run against the
**compiled** bundle to work at all:
[../../common/request-reply-invariant.md](../../common/request-reply-invariant.md).

**`account-usage-integration.spec.ts:132` fixed too (test side).** Its guard probes the live
API once; the **server** then makes its own call a second later, and this endpoint
rate-limits hard enough that the two routinely disagree. The artifact showed the modal
correctly rendering `Usage data is unavailable: rate limited (HTTP 429).` while the
assertion demanded 3 rows. It now skips on that state, matching what the sibling test at
:109 already tolerates.

## Related

- [common/oauth-usage-api.md](../../common/oauth-usage-api.md) - the usage endpoint reference.
- [common/request-reply-invariant.md](../../common/request-reply-invariant.md) - answer every request once, and the synchronous-throw trap behind `fetchAccountInfo`.
- [streaming-and-input-ui/](../streaming-and-input-ui/) - same `main`-branch session lineage; touches `cliHandler.ts` / `session.ts` / `InputArea.tsx`.
