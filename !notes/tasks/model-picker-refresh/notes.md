# model-picker-refresh: Fix stale current-model highlight; auto-refresh model list/descriptions via the daemon

**Task:** ad-hoc (no tracker ticket). Requested 2026-08-04 in chat; work happens directly on `main` (repo convention: no feature branches for personal work).

## Problem

Classification: **bug + feature** in one request.

1. **Bug (current-model highlight):** The Models tab (Account modal) and the InputArea quick picker highlight the active model via `m.id === currentModel`. Sometimes after picking Claude Fable 5 the highlight does not move / other panels keep showing "Default (CLI)" as active (screenshot: Default row green with "Currently claude-sonnet-4-6").
2. **Bug (blank/stale descriptions):** `MODEL_DESCRIPTIONS` is a hardcoded exact-id map duplicated in `AccountUsageModal.tsx` and `InputArea.tsx`. Models missing from the map (claude-opus-5, claude-sonnet-5, claude-opus-4-6, claude-opus-4-5) render with no description. The Fable description "Creative and expressive" was invented; the CLI's own wording for the top tier is "Most capable for your hardest and longest-running tasks".
3. **Feature (daily refresh):** Record in the global config (`~/.claude/argus.json`) when the daemon (the server, not individual CLI processes) last started; if more than 24h have passed since model data was refreshed, run a refresh script that updates the model descriptions, the model list fallback, and the detected CLI default model (`runtimeDefaultModel`, today only refreshed manually via `yarn detect-model`).

## Root cause

**Highlight bug:** `switchModel` / `switchEffort` / `switchThinking` (session.ts) write the config globally but update the cached per-entry state (`s.model` / `s.effort` / `s.thinking`) and broadcast `modelChanged` only within the **current workspace channel** (`channel.forEachSession` / `channel.broadcastToAll`). Panels in other workspaces served by the same daemon keep the stale cached value forever:

- their `getInfo` reply (`workspaceInfo {model: s.model}`) overwrites the webview's `currentModel` with the stale value (reducer.ts `workspaceInfo` case), so the picked model is not highlighted there;
- their next CLI spawn still passes the old `--model`.

Secondary contributors:
- cross-process staleness (dev server :3001 vs daemon :3017 share argus.json but each keeps its own in-memory entry state);
- exact-string compare `m.id === currentModel` breaks when one side is a dated snapshot id (`claude-haiku-4-5-20251001`) and the other the dateless alias.

**Descriptions:** exact-id map goes stale with every model release. The CLI itself resolves descriptions **by family** (binary contains `if(t.includes("fable"))return"fable"` etc. + per-family strings), which never goes stale for new snapshots of known families.

## Plan

### Part 1 - highlight fix (config = single source of truth)
1. `sessionState.ts`: drop `model`/`effort`/`thinking` fields; add `serverDefaultModel` (env `ARGUS_MODEL` fallback, seeded from the `model` param in `initChannelSession`).
2. `session.ts`: `getInfo` and the spawn-args block derive live values from `readConfig()` (`cfg.model || s.serverDefaultModel`, `cfg.effort`, `cfg.thinking`); switch handlers become `writeConfig` + global broadcast; no per-entry state updates.
3. `channel.ts`: new module-level `broadcastToAllChannels(msg)` (iterates the registry across all workspace dirs); remove now-unused `broadcastToAll`/`forEachSession` from the Channel facade.
4. Webview: shared `webview/src/utils/model.ts` with `sameModel(a, b)` (strip `-20\d{6,8}` date suffix before compare) used for the checkmark/highlight in both components.

### Part 2 - descriptions + daily refresh
1. New `src/backend/modelData.ts`: `modelFamily(id)`, baked `FAMILY_DESCRIPTIONS` (fable/opus/sonnet/haiku, wording from CLI 2.1.197), `describeModel(id, cfg)`, `detectDefaultModel()` (ported from scripts/detect-default-model.js, with kill timeout), `extractFamilyDescriptions()` (locates the installed claude binary, Buffer-scans for `value:"sonnet",label:...,description:"..."` triplets; fable found as the unknown 4th string clustered after the haiku string; all failures degrade to baked strings), `refreshModelData()` (detect + extract + `fetchModels()`, then read-modify-write config), `scheduleModelDataRefresh()` (stamps `daemonLastStartAt` on every daemon start; runs refresh when `now - modelDataUpdatedAt >= 24h`; hourly unref'd re-check for long-running daemons; env kill-switch `ARGUS_MODEL_REFRESH=0`).
2. `config.ts`: new fields `daemonLastStartAt: 0`, `modelDataUpdatedAt: 0`, `modelFamilyDescriptions: {}`, `modelListCache: []`.
3. `daemon.ts`: call `scheduleModelDataRefresh` after successful listen.
4. `session.ts` `getModels`: attach `description` server-side (`describeModel`); on fetch failure fall back to `modelListCache`; persist a changed successful list into the cache.
5. Webview: both components use server-sent `description` first, then local family fallback (`describeModel(id)` in utils/model.ts - needed for old-daemon skew); shared `FALLBACK_MODELS` + `makeDefaultEntry` move there too; drop the stale "run scripts/detect-default-model.js" hint.
6. Scripts: delete `scripts/detect-default-model.js`; add `scripts/update-model-data.js` (thin wrapper over compiled `out/backend/modelData.js`); package.json script `detect-model` -> `update-models`.

### Decision: gate on modelDataUpdatedAt, not daemonLastStartAt
The literal request was "if 24h passed since the daemon last started". The daemon self-exits after 10 min idle and respawns on demand, so consecutive starts are usually hours apart and a start-to-start gate would never fire. Gating refresh on the last successful refresh (`modelDataUpdatedAt`) delivers the intent (data at most a day old) while `daemonLastStartAt` is still recorded as requested.

### Verification
- **Environment:** `yarn dev` (Vite :5173 + server :3001); daemon path: `yarn build && yarn compile`, `yarn daemon:stop`, reopen a panel/browser tab on :3017.
- **Automated tests:** new mock spec `e2e/model-picker.spec.ts` (family-fallback descriptions incl. fable wording, server description wins, dated-vs-dateless highlight both directions); new cross-dir switchModel test in `shared-channel-integration.spec.ts`; `daemonLastStartAt` write asserted in `daemon-lifecycle-integration.spec.ts`; `ARGUS_MODEL_REFRESH: '0'` added to `daemonHelpers.ts` env so daemon specs never spawn a real CLI turn.
- **Manual:** run `yarn compile && node scripts/update-model-data.js`, inspect argus.json (4 family descriptions incl. fable extracted from the real binary, runtimeDefaultModel updated, modelListCache filled, modelDataUpdatedAt stamped); `yarn dev`, open two browser tabs with different `?dir=`, pick Fable 5 in one, verify the checkmark lands in both; Models tab shows a description on every row.

## Changes made
- **Highlight fix**: `SessionState` dropped `model`/`effort`/`thinking` (kept only `serverDefaultModel`, the ARGUS_MODEL fallback); `getInfo` and the CLI spawn args derive all three from `readConfig()` at use time; `switchModel`/`switchEffort`/`switchThinking` now write the config and notify via the new module-level `channel.broadcastToAllChannels()` (every client of every workspace channel); the per-channel `Channel.broadcastToAll`/`forEachSession` facade methods are removed (were only used by the switch handlers).
- **Webview matching**: new shared `webview/src/utils/model.ts` (`describeModel`, `sameModel`, `FALLBACK_MODELS`, `makeDefaultEntry`, `toModelEntry`); both `AccountUsageModal` and `InputArea` dropped their duplicated `MODEL_DESCRIPTIONS`/fallback copies; active-row checkmark uses `sameModel()` (strips a trailing `-20\d{6}` snapshot date on either side); the stale "run scripts/detect-default-model.js" hint removed.
- **Descriptions**: family-based (fable/opus/sonnet/haiku by substring, like the CLI itself). Server resolves them in the `getModels` reply (`describeModel` in `src/backend/modelData.ts`: config-extracted strings, else baked-in). Fable's wording corrected to the CLI's "Most capable for your hardest and longest-running tasks" ("Creative and expressive" was invented).
- **Model list fallback**: successful `/v1/models` fetches persist to `modelListCache` in argus.json; a failed fetch serves the cache before the hardcoded trio.
- **Daily refresh**: new `src/backend/modelData.ts` with `refreshModelData()` (CLI default model detection via a minimal turn in tmpdir + family-description extraction from the installed CLI bundle + `/v1/models` re-fetch) and `scheduleModelDataRefresh()` called by `daemon.ts` after binding: stamps `daemonLastStartAt` every launch, refreshes when `modelDataUpdatedAt` is >24h old, re-checks hourly; `ARGUS_MODEL_REFRESH=0` kill switch. New config fields: `daemonLastStartAt`, `modelDataUpdatedAt`, `modelFamilyDescriptions`, `modelListCache`.
- **Scripts**: `scripts/detect-default-model.js` deleted; `scripts/update-model-data.js` added (`yarn update-models`, wraps compiled `out/backend/modelData.js`).
- **e2e**: new mock `e2e/model-picker.spec.ts` (5 tests); cross-dir switchModel regression test in `shared-channel-integration.spec.ts`; `daemonLastStartAt` test in `daemon-lifecycle-integration.spec.ts`; `daemonHelpers.startDaemon` now always isolates `ARGUS_CONFIG` (throwaway file when no `configPath`) and sets `ARGUS_MODEL_REFRESH=0`; `getModels` added to `MOCK_SUPPRESSED` in `webview/index.html`.

## Files changed
- src/backend/modelData.ts (new)
- src/backend/config.ts, sessionState.ts, session.ts, channel.ts, daemon.ts
- webview/src/utils/model.ts (new), webview/src/components/AccountUsageModal.tsx, InputArea.tsx, webview/index.html
- scripts/update-model-data.js (new), scripts/detect-default-model.js (deleted), package.json (`detect-model` -> `update-models`; version already bumped to 0.0.81)
- e2e/model-picker.spec.ts (new), e2e/shared-channel-integration.spec.ts, e2e/daemon-lifecycle-integration.spec.ts, e2e/daemonHelpers.ts
- CLAUDE.md, !notes

## Gotchas
- `readConfig()` is mtime-cached, so deriving model/effort/thinking at use time costs one `statSync` per call - fine.
- `updateSettings` allowlist (`k in DEFAULT_CONFIG`) now includes the new data fields; harmless (connection is already origin+nonce authorized).
- Version skew: old daemon + new webview still renders descriptions (local family fallback); new daemon + old webview ignores the extra `description` field - both degrade gracefully.
- **Extraction pitfalls (hit during implementation)**: anchoring on `value:"sonnet",label:` alone matches an opus-plan picker entry ("Use Opus in plan mode, Sonnet otherwise") - the anchor must include the label (`label:"Sonnet",description:"`); and the fable cluster heuristic must NOT seed its "known strings" set with the baked fable wording, or the real match is rejected as already-known.
- **Mock clobber race**: mock specs dispatch `modelList` via window events while the real dev backend also answers `getModels` - its late reply overwrote the injected list intermittently under 4-worker load. Fixed by adding `getModels` to `MOCK_SUPPRESSED` (plus a `toPass` re-dispatch loop for the effect-registered listener). The same race still exists for `getServerInfo` in `version-skew.spec.ts` (pre-existing, flaky-but-retried; can't be suppressed the same way because `kill-all-claude.spec.ts` asserts on the outgoing `getServerInfo` send).
- Manual refresh confirmed the reported staleness: config said `runtimeDefaultModel: claude-sonnet-4-6` while the actual CLI default is `claude-sonnet-5`; `/v1/models` returns dateless alias ids for the 5-family (claude-opus-5, claude-sonnet-5, claude-fable-5) plus 11 models total.

## Decisions
- Refresh gate on `modelDataUpdatedAt` (see above).
- Family-based descriptions instead of exact-id map (mirrors the CLI's own logic, immune to new snapshot releases).
- Fable description corrected to the CLI's wording "Most capable for your hardest and longest-running tasks".
- Company task registry (`scub111g/!notes/tasks/`) not updated: its scope line restricts it to cross-project/infra tasks, and argus per-task notes have never been mirrored there.

## Superseded

- **Was:** one clock, `modelDataUpdatedAt`, stamped at the end of every refresh regardless of
  whether the `/v1/models` fetch succeeded, so a broken environment retried daily rather than on
  every daemon start.
- **Actually:** two clocks. `modelDataUpdatedAt` advances only when a model list actually came
  back; a new `modelDataAttemptedAt` advances on every attempt and gates retries to once an hour.
  `shouldRefreshModelData()` requires both.
- **Why it was wrong:** not wrong when written, it was a deliberate tradeoff (see the comment it
  carried), but it charged the wrong thing for respawn protection. A failed fetch left the window
  unknown, and `contextWindowFor` then falls back to 200k, which on a 1M model is a percentage 5x
  too high, held for a full day. The attempt clock buys the same protection without that cost.
- **Corrected by:** [model-refresh-retry-backoff](../model-refresh-retry-backoff/notes.md)

The "gate on `modelDataUpdatedAt`, not `daemonLastStartAt`" decision above still holds; only the
stamping rule changed.

## Remaining work
- ~~Not committed yet~~ Committed and pushed on 2026-08-06 as `79b8461` on `main` (version 0.0.82).
- The live daemon still runs the old build: activate with `yarn daemon:stop` + open a panel (or the Settings restart button). Not done from the agent session because it kills live CLI sessions hanging off the daemon. Confirmed still true on 2026-08-06 (daemon spawned from the installed `local.argus-0.0.80` folder, so the extension install also needs a rebuild+reinstall for the webview side).
- Reconnect re-sync gap (found 2026-08-06, see the follow-up section): webview never re-posts `getInfo` after `ws_status connected`, so model/effort/thinking display can stay stale across a daemon restart even with this fix deployed. Proposed, not implemented.
- ~~version-skew flake~~ FIXED in this task: the 0.0.81 bump turned the latent clobber race (real `getServerInfo` reply vs mocked `serverInfo`) into 4/4 hard failures; `version-skew.spec.ts` now drops the outgoing `getServerInfo` at the socket via `page.addInitScript` (per-spec, so `kill-all-claude.spec.ts`'s outgoing-send assertions are untouched). Full mock suite: 184/184, zero flaky.

## Verification results (2026-08-04)
- Mock suite: 182/182 passed (5 new in `e2e/model-picker.spec.ts`).
- Integration suite: 111 passed, 3 skipped (the documented AskUserQuestion skips), 0 failed, 5.8 min.
- Manual: `node scripts/update-model-data.js` against the real CLI 2.1.197 extracted 4/4 family descriptions, detected default `claude-sonnet-5` (config had stale `claude-sonnet-4-6`), cached 11 models; existing argus.json settings untouched.

## 2026-08-06 follow-up: screenshot mismatch triage

User report: a turn's reply self-identifies as Claude Fable 5 (`claude-fable-5`), while the Models tab checkmark sits on "Default (CLI)" with "Currently claude-sonnet-5" (and the footer shows "Effort (High)" though config effort is `max`). Findings:

- The panel is served end-to-end by the pre-fix 0.0.80 build: the daemon (pid from the discovery file) was spawned from `c:\Users\Admin\.vscode\extensions\local.argus-0.0.80\out\backend\daemon.js`, and the webview bundle is old too (Fable row shows the invented "Creative and expressive"; Opus 5 / Sonnet 5 / Opus 4.6 / Opus 4.5 rows have blank descriptions). `daemonLastStartAt` is still 0, so `scheduleModelDataRefresh` has never run.
- The reply is the truthful side: argus.json had `model: claude-fable-5`, `effort: max` (mtime 00:50); the daemon restarted 07:08 and the fresh entry seeded `s.model` from config (old `initChannelSession`: `s.model = cfg.model || model`), so the 07:38 turn spawned with `--model claude-fable-5`.
- The checkmark and effort label are stale webview React state: the switch was made on a surface this webview does not listen to (another workspace's channel, another server process, or a direct config edit; a same-dir panel is excluded because old `broadcastToAll` covers the whole channel), and nothing re-syncs after reconnect, so even the 07:08 daemon restart did not refresh the display.
- "Currently claude-sonnet-5" is CORRECT, not stale: the CLI's own `~/.claude/settings.json` pins `"model": "sonnet"`. Re-ran the tmpdir detection turn on 2026-08-06: still `claude-sonnet-5`. It only looks contradictory because the checkmark is wrongly parked on the Default row.
- **Residual gap the current fix does not cover**: `getInfo` and `webviewReady` are posted only in App's mount effect (webview/src/App.tsx `[]` effect); there is no re-send on `ws_status connected`, and the server pushes `workspaceInfo` on `webviewReady` only in the deep-link branch (path only, no model). So with the new build everywhere, a switch missed while disconnected (daemon restart window), a cross-process switch (dev :3001 vs daemon), or a hand-edited argus.json still leaves a stale checkmark until the webview remounts. Candidate fix: re-post `getInfo` on reconnect, mirroring SettingsModal's `getServerInfo` re-fetch on `ws_status connected`.

## Related tickets
- !notes/tasks/version-skew-direction/ (why a stale daemon can be serving a new panel)
- !notes/tasks/single-daemon-server/ (daemon lifecycle the refresh hooks into)
