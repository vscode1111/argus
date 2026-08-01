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
| [common/oauth-usage-api.md](common/oauth-usage-api.md) | Anthropic usage API | Live `/api/oauth/usage` endpoint: token source, response shape (0-100 percent), window allowlist, 429 rate-limiting |
| [common/security.md](common/security.md) | Security hardening | WebSocket origin validation, path traversal protection, settings allowlist |
| [common/backend-restart.md](common/backend-restart.md) | Restarting the backend | The daemon runs from the panel's own install (repo `out/` or `~/.vscode/extensions/local.argus-<v>/`), never watched; `daemon-stop.js` + respawn; verify the `version` in the discovery file; what needs `yarn build` vs `yarn compile` |
| [common/markdown-file-paths.md](common/markdown-file-paths.md) | File paths in markdown | The two path regexes (`WIN_PATH_RE` escape pass / `FILE_PATH_RE` linkifier) must stay in sync; escaping skips code spans; `!` allowed in dir segments only; relative links navigate only inside the previewer; 5000-char cap |
| [common/e2e-testing.md](common/e2e-testing.md) | Playwright e2e | Flat 30s timeout for mock and integration alike (rare justified per-test exceptions allowed), `/health` + `global-setup.ts` guard against a reused wrong-config dev server; integration `workers: 1` + cascade signature; running with captured backend stdout; writing model-independent assertions (gate on Stop via waitFor, not tool calls); a disk-replayed transcript has no timers/token counts; CLI-memory pollution in "must have forgotten" tests; `e2e/argus.json` is the full settings config hydrated over `getSettings`; `showLogs:true` gotcha; message-injection idiom |

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
