# Common Instructions

| File | Topic | Summary |
|------|-------|---------|
| [oauth-usage-api.md](oauth-usage-api.md) | Anthropic usage API | Live `/api/oauth/usage` endpoint: token source, response shape (0-100 percent), window allowlist, 429 rate-limiting |
| [security.md](security.md) | Security hardening | WebSocket origin validation, path traversal protection, settings allowlist |
| [e2e-testing.md](e2e-testing.md) | Playwright e2e | Tiered timeouts (mock 30s / integration 90s, retries 0, no per-test setTimeout); integration `workers: 1` + cascade signature; running with captured backend stdout; writing model-independent assertions (gate on Stop via waitFor, not tool calls); a disk-replayed transcript has no timers/token counts; CLI-memory pollution in "must have forgotten" tests; `e2e/argus.json` is the full settings config hydrated over `getSettings`; `showLogs:true` gotcha; message-injection idiom |
