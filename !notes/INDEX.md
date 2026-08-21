# _notes

Parent: company-level knowledge base at [../../!notes/INDEX.md](../../!notes/INDEX.md).

| Folder | Purpose |
|--------|---------|
| [common/](common/) | Shared instructions and guides applicable to all tasks |
| [tasks/](tasks/) | Per-task investigation notes grouped by ticket ID |
| [issues/](issues/) | Tracked bugs / investigations with root-cause analysis and attempt logs |
| [plans/](plans/) | Master plan: open bugs, deferred ideas, implemented history |
| temp/ | Temporary files, safe to delete |

## Quick lookup

### Common docs
| File | Topic | Summary |
|------|-------|---------|
| [common/oauth-usage-api.md](common/oauth-usage-api.md) | Anthropic usage API | Live `/api/oauth/usage` endpoint: token source, `limits` array first (only source of model-scoped windows like Weekly Fable), legacy window allowlist fallback (0-100 percent), 429 rate-limiting |
| [common/model-context-windows.md](common/model-context-windows.md) | Model context windows | `/v1/models` `max_input_tokens` is the source of truth; the CLI's own `modelUsage.contextWindow` silently reports 200k for any model missing from its bundled registry (opus-5); the window is not family-derivable (opus-4-5 200k vs opus-4-6 1M); official percentage excludes output tokens; context fill is not a compaction signal |
| [common/cli-bundle-mining.md](common/cli-bundle-mining.md) | Extracting logic from the CLI exe | The CLI is a Bun-compiled exe with plain minified JS embedded: grep -aob anchors, distinguish the bytecode region (island strings, no code) from the JS region before extracting windows via Node buffer reads; used for model descriptions and the usage-insights algorithm |
| [common/security.md](common/security.md) | Security hardening | WebSocket origin validation, path traversal protection, settings allowlist, process spawning/termination (execFileSync, no shell) |
| [common/backend-restart.md](common/backend-restart.md) | Restarting the backend | The daemon runs from the panel's own install (repo `out/` or `~/.vscode/extensions/local.argus-<v>/`), never watched; `daemon-stop.js` + respawn; an already-open panel respawns it unattended via the reconnect loop's `needWsUrl`, so a stop only sticks for the panel that asked; verify the `version` in the discovery file; what needs `yarn build` vs `yarn compile`; restarting from inside an Argus conversation needs [common/scripts/restart-daemon-detached.js](common/scripts/restart-daemon-detached.js) (delayed, detached, target-first swap - a direct kill aborts the requesting turn, and kill-then-start loses the respawn race to still-open old-install windows) |
| [common/markdown-file-paths.md](common/markdown-file-paths.md) | File paths in markdown | The two path regexes (`WIN_PATH_RE` escape pass / `FILE_PATH_RE` linkifier) must stay in sync; escaping skips code spans; `!` allowed in dir segments only; relative links navigate only inside the previewer; 5000-char cap |
| [common/e2e-testing.md](common/e2e-testing.md) | Playwright e2e | Flat 30s timeout for mock and integration alike (rare justified per-test exceptions allowed), `/health` + `global-setup.ts` guard against a reused wrong-config dev server; integration `workers: 1` + cascade signature; running with captured backend stdout; writing model-independent assertions (gate on Stop via waitFor, not tool calls); a disk-replayed transcript has no timers/token counts; CLI-memory pollution in "must have forgotten" tests; `e2e/argus.json` is the full settings config hydrated over `getSettings`; `showLogs:true` gotcha; message-injection idiom; mock data clobbered by real backend replies (MOCK_SUPPRESSED, per-spec socket drop, toPass re-dispatch); `e2e/argus.json` drift from config-persisting features; child processes inherit `FORCE_COLOR` so `console.log(number)` returns ANSI-wrapped and parses as NaN; chromium revision drift after a `^` minor bump fails every browser test in `browserType.launch`; never automate a real destructive OS action, verify against a decoy process; the mock project is not immune to a wrong-config dev server (plus a mock-only escape-hatch config for when stopping the user's server is too costly); run the red before trusting a regression test; gate a clipboard read on the button's ✓; a threshold belongs at the code's real boundary, not a comfortable-looking number; back-to-back runs hand off a dying dev server (refused `page.goto`, not the cascade); `test-results/` is wiped at each run start, so copy a flake's `error-context.md` (it carries the app's Debug Log) before anything else; a red run of a webview fix needs a rebuild (the browser loads the built bundle, not the source) and controls that stay green localize the bug; Vite-alive/backend-dead adoption is a third dev-server failure mode, and a spec talking to :3001 directly must poll /nonce because the readiness gate only watches Vite; an event both the healthy and broken path emit (`done`) needs an ordering gate against the turn's own `thinking_start` |
| [common/overlay-controls-on-scrollable.md](common/overlay-controls-on-scrollable.md) | Overlay controls over scrollable regions | An absolutely positioned child of a scroll container is anchored at scroll origin and scrolls away with the content (not pinned to the scrollable edge, as intuition suggests); split the scroll container from the positioning context via a non-scrolling wrapper, give the control an opaque background, verify with a control run |
| [common/development.md](common/development.md) | Local dev setup | Nothing typechecks `webview/` (vite strips types, `tsc -p ./` covers only `src/`) so run `npx tsc -p webview/tsconfig.json --noEmit` by hand; `C:` drive can be completely full, breaking `yarn install` with `ENOSPC` even though the project lives on `D:` (yarn's cache defaults to `C:`); workaround via `--cache-folder`; a tab left open across a `yarn dev` restart can hang on the loading spinner - hard refresh fixes it |
| [common/state-lifetime-in-message-tree.md](common/state-lifetime-in-message-tree.md) | UI state that must outlive a turn | A tool block is rendered by `StreamingMessage` while the turn runs and by `ChatMessage` once it commits, so state held inside it (an open preview) dies at the commit boundary and `createPortal` does not help; own it in a provider above the message list, pass a stable `children`, resolve async content in the host |

### Issues
| Issue | Status | Summary |
|-------|--------|---------|
| [issues/toast-click-focus-cross-desktop.md](issues/toast-click-focus-cross-desktop.md) | open / unverified fix | Toast click does not bring VS Code forward across virtual desktops |
| [issues/integration-suite-cascade-crash.md](issues/integration-suite-cascade-crash.md) | resolved / verified | 29 integration failures were one backend crash: leaked CLI procs -> resource exhaustion -> synchronous `spawn()` throw |
| [issues/file-viewer-grey-line-boxes.md](issues/file-viewer-grey-line-boxes.md) | resolved / verified | VS Code's injected webview stylesheet paints `<code>` backgrounds; fix via `codeTagProps` |

### Task notes
See [tasks/INDEX.md](tasks/INDEX.md) for the full per-task table.

## Standalone docs (legacy)

| File | Topic |
|------|-------|
| [background-tasks.md](background-tasks.md) | Background task implementation notes |
| [optimizations.md](optimizations.md) | Performance work and benchmarks |
| [security-audit.md](security-audit.md) | Security audit findings and fixes |
