# _notes

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
| [common/e2e-testing.md](common/e2e-testing.md) | Playwright e2e | Tiered timeouts; integration `workers: 2` + cascade signature; captured backend stdout; model-independent assertions; CLI-memory pollution; `e2e/argus.json` gotchas |

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
