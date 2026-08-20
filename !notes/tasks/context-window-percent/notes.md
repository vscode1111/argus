# Context-usage pill: percentage of the model's own window

## Problem

Reported from the panel: on a non-default model the context pill sat at **100%** while nothing
compacted. Screenshot showed a live turn at `337,837 in` with the pill pegged at 100%.

Two independent things were conflated in the report, and only one was ours:

1. **The pill was wrong.** `src/backend/cliHandler.ts` divided by a hardcoded
   `MAX_CONTEXT = 200_000` for every model. The session was on `claude-opus-5`, whose real window
   is 1M, so 337k was ~34% full and the pill said 100%.
2. **Auto-compaction was never ours.** Compacting is entirely the Claude CLI's business; Argus
   neither triggered it before nor does now. "100% but no compact" was the pill lying, not a broken
   trigger.

Background facts (window sources, why the CLI's own number cannot be trusted, why family
heuristics fail, the official percentage formula): [common/model-context-windows.md](../../common/model-context-windows.md).

## Changes made

- `src/backend/accountUsage.ts` - `ModelInfo.contextWindow`, filled from `max_input_tokens` in the
  `/v1/models` reply.
- `src/backend/config.ts` - `modelListCache` entries carry the optional `contextWindow`.
- `src/backend/modelData.ts` - `DEFAULT_CONTEXT_WINDOW` (200k) and `contextWindowFor(id, cache?)`:
  looks the id up in the cached list, stripping a `-20\d{6}` snapshot date from both sides so
  `claude-haiku-4-5` matches the cached `claude-haiku-4-5-20251001` and vice versa, else the default.
- `src/backend/cliHandler.ts` - percentage over `contextWindowFor(event.message.model)`, taken from
  the model that produced *this* message rather than from config; output tokens dropped from the
  numerator; the `contextUsage` frame now also carries `contextWindow`.
- `webview/src/reducer.ts`, `webview/src/components/InputArea.tsx` - `ContextUsage.contextWindow`
  plumbed through and rendered as a `Window: N tokens` line in the pill tooltip.
- `e2e/context-window-integration.spec.ts` - new spec (4 tests).
- `CLAUDE.md` - Context usage indicator entry, accountUsage/modelData structure lines, e2e list.

**Cold-cache behaviour is deliberate.** `modelListCache` in an existing `~/.claude/argus.json`
predates the field, so windows only arrive on the next model-data refresh (daily, on picker open,
or `yarn update-models`). Until then every model resolves to 200k, which is exactly the old
behaviour - no regression while the cache is cold, and no new failure mode if the fetch is broken.

## Verification

- `scripts/verify-context-usage.js <model>` - starts its own server on `:3099` with a throwaway
  config copy (the running daemon and the real `argus.json` untouched), runs one real turn in a
  temp cwd, prints every `contextUsage` frame and re-checks the arithmetic. Observed:
  - `claude-opus-5` -> `1%  input=14,048  window=1,000,000` (would have been 7% before)
  - `claude-haiku-4-5` -> `9%  input=18,580  window=200,000`, resolved through the **dated** cache
    entry, so the snapshot normalisation is exercised in the live path, not only in unit-style tests
- `e2e/context-window-integration.spec.ts` 4/4; full mock suite 192/192; neighbouring integration
  specs (token-spending, workspace-info-config) 8/8.
- `yarn compile` clean. `npx tsc --noEmit -p webview/tsconfig.json` reports only the two
  pre-existing errors (`FileViewerModal.tsx` SyntaxHighlighter JSX typing, `filePath.tsx` `endLine`
  prop) in files this task did not touch.

## Gotchas

- **The obvious source was the wrong one.** The CLI's `result` event already carries
  `modelUsage[<model>].contextWindow` - free, per-turn, and it *looks* authoritative. A real turn
  disproved it: `claude-opus-5` comes back as `200000`. The CLI resolves the window from a registry
  baked into its own bundle and silently defaults when the id is missing, so it is correct only for
  models older than the installed CLI. Details in
  [common/model-context-windows.md](../../common/model-context-windows.md).
- **Family fallback looked natural and is wrong.** `modelData.ts` already classifies by family
  substring for descriptions, so reusing it for windows was the first instinct. `opus-4-5` is 200k
  while `opus-4-6` is 1M - same family, different window. Unknown ids take the 200k default instead.
- **A `NaN` that looked like a broken import.** The spec's child process printed the window with
  `console.log(number)` and the parent parsed `NaN`, which reads like the module failed to load or
  the config was not picked up. It was neither: Playwright sets `FORCE_COLOR`, so the number came
  back ANSI-wrapped. Written up in [common/e2e-testing.md](../../common/e2e-testing.md).

## Remaining work

None for the pill.

Open question recorded in [common/model-context-windows.md](../../common/model-context-windows.md):
the CLI did not compact a `claude-opus-5` session at 337k even though its own registry puts that
model's window at 200k, so the compaction point for a model newer than the installed CLI is not
understood. Costs nothing today (the real window is 1M).

## Side finding, unrelated to this change

`@playwright/test` had drifted to 1.59.1 (wants chromium 1217) while only 1208 was installed, so
every browser-based e2e on this machine failed in `browserType.launch` before any test body ran.
Fixed with `node scripts/install-browsers-manual.js`. Diagnosis and the version-check commands are
in [common/e2e-testing.md](../../common/e2e-testing.md); the `^1.59.0` range means it can recur on
any fresh `yarn install`.
