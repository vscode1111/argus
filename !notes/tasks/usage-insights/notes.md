# Usage insights ("What's contributing to your limits usage?") + Weekly Fable window

## Problem

The Account & Usage modal lacked two things the official Claude Code usage panel shows:

1. The **"What's contributing to your limits usage?"** section: Day/Week local-analysis insights ("70% of your usage was at >150k context", "47% ... sessions active for 8+ hours") plus **Skills / Subagents / Plugins / MCP servers** attribution tables with "% of usage".
2. The **"Weekly Fable"** usage bar - a model-scoped weekly window that never appeared in Argus.

## Discovery

- The insights are computed **locally** by the official client ("Approximate, based on local sessions on this machine"), not served by an API. The exact algorithm was extracted from the installed CLI exe (2.1.197) via the technique in [common/cli-bundle-mining.md](../../common/cli-bundle-mining.md); raw source extracts are kept in [scripts/calc.js.txt](scripts/calc.js.txt) and [scripts/ui.js.txt](scripts/ui.js.txt) (160KB windows of minified JS around byte offsets ~206M / ~227.7M; **gitignored** - third-party minified source, local reference only).
- **Weekly Fable** comes from the `/api/oauth/usage` response's newer `limits` array (`kind: "weekly_scoped"`, `scope.model.display_name: "Fable"`). It is **never** present among the legacy top-level window keys (`seven_day_opus`/`seven_day_sonnet` stay `null` on this account while the scoped entry exists). Documented in [common/oauth-usage-api.md](../../common/oauth-usage-api.md).

## The official algorithm (as mirrored in src/backend/usageInsights.ts)

- **Scan**: all `~/.claude/projects/*/*.jsonl` plus `<project>/<session-data-dir>/subagents/**/*.jsonl`; files with mtime older than 7 days skipped; 4 files parsed concurrently per batch.
- **Event** = transcript line containing `"type":"assistant"` and `"usage":{`; fields read by substring (no JSON.parse): timestamp, sessionId, input/output/cache_creation/cache_read tokens (skip if all zero), `"isSidechain":true` (subagent), model, `requestId` (dedup key; falls back to the `msg_` id, then `uuid`), and - only when `"attribution` is present - `attributionAgent/Skill/Plugin/McpServer`.
- **Dedup**: global first-wins Set on the uuid (streaming rewrites duplicate one API response across lines under one requestId).
- **Cost** = `(cache_read + input*10 + cache_creation*12.5 + output*50) * modelTier`, tier by family substring: fable=10, opus=5, haiku=1, else 3.
- **Windows**: one pass fills both accumulators - week (all events, cutoff 7d at parse time) and day (events with ts >= now-24h).
- **Behaviors** (keys are the official ones; pct = round(cost share)):
  - `cache_miss`: events with uncached input > 100k tokens
  - `long_context`: events with cache_read+cache_creation+input > 150k
  - `subagent_heavy`: sessions with >= 3 subagent events OR subagent cost share > 0.5 (count = sessions)
  - `high_parallel`: events in 5-minute buckets containing >= 4 distinct sessionIds
  - `cron` (the "8+ hours" line): sessions active in >= 8 **distinct hours** (`Set(floor(ts/3600000))`, not last-first duration; count = sessions)
- **Attribution tables**: cost summed per name; agent-attributed events go to Subagents keyed by `attributionSkill ?? attributionAgent`, others to Skills by `attributionSkill`; pct rounded, 0% rows dropped, sorted desc.
- **UI rules** (also official): behaviors under 10% (`MIN_BEHAVIOR_PCT`) hidden; tables cap at 8 rows + "… N more"; skills rendered as `/name`; all-empty tables show "No attribution data yet · accumulates as you use Claude"; official copy per behavior key (headline + advice body).
- **Compact empty states** (user feedback): the Day/Week toggle and the two disclaimer paragraphs render only once a report is present; while loading or after a collection failure the section is just the header + one hint line. Rationale: the scaffolding around no data looked heavy next to a usage-API error - but the section itself stays, because the insights are local and independent of that API (they are the only usage info available while it is rate-limited).

## Changes made

- `src/backend/usageInsights.ts` (new): the mirror above; `collectUsageInsights(force)` with 60s cache + shared in-flight promise.
- `src/backend/accountUsage.ts`: `parseUsageResponse` now parses the `limits` array first (session -> `five_hour`, weekly_all -> `seven_day`, weekly_scoped -> `seven_day_<name>` with `label: "Weekly <Name>"`), legacy keys as fallback; `RateLimitInfo.label` added.
- `src/backend/sessions.ts`: `projectsRoot()` exported (reused by the scanner).
- `src/backend/session.ts`: `getUsageInsights` -> `usageInsights {day, week}` / `{error}` handler (per-client ws.send, next to `getAccountUsage`).
- `webview/src/components/AccountUsageModal.tsx` + `.module.css`: insights section below the usage bars (Day/Week `role=tab` toggle, disclaimers, behavior blocks with official copy, `InsightTable` component); usage bars prefer `rl.label`; `RATE_LIMIT_META` gains `seven_day_fable` (order 2).
- `webview/index.html`: `getUsageInsights` added to `MOCK_SUPPRESSED`.
- `e2e/usage-insights.spec.ts` (new, 7 mock tests), `e2e/usage-insights-integration.spec.ts` (new, 2 tests), `e2e/account-usage.spec.ts` (+1 test: scoped-window labels + sort), `e2e/account-usage-integration.spec.ts` (`fetchLiveUsage` mirrors the limits-first parsing).
- `package.json`: version 0.0.84.

## Verification

- `collectUsageInsights()` on this machine reproduced the official panel screenshots: Day - long_context 70% (official 70%), skills update-notes 9% / review 5% / git-commit-push 1% (identical), MCP windows-mcp 5% vs 6%, chrome-devtools 4% (drift = time passed since the screenshot); Week - 62/24/18% vs official 61/24/18%, all table rows identical. Scan of a week of real history: ~1.3s.
- e2e: 19 mock (incl. all account-usage regressions) + 4 integration passed; the live-API comparison test skipped by design under HTTP 429.

## Gotchas

- **First extraction window hit Bun bytecode, not JS.** The anchor string exists at 4+ byte offsets in the exe; the ~124M/130M and ~206M clusters are the bytecode/heap section - identifiers and copy are visible but no code. The analyzable minified JS lives at the ~227.7M cluster. Signal: the window around the anchor is `ÿÿÿ` binary with island strings instead of `function` code.
- **/api/oauth/usage rate-limits within a handful of calls** (HTTP 429 with a valid token) - it throttled during this very research session. Any test comparing against the live endpoint must skip on failure, not assert.
- **The "8+ hours" insight is not duration.** Internally `cron`, it counts >= 8 distinct wall-clock hours with activity; a session spanning 9 hours with events in 2 of them does not qualify.
- **Legacy usage keys never gain new model windows.** Waiting for a `seven_day_fable` top-level key would wait forever; only the `limits` array carries scoped windows.

## Remaining work

None.
