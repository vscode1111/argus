# Anthropic OAuth usage API

The live endpoint the official Claude Code panel uses to show subscription usage. Reusable reference for any feature that needs account-level usage/limits.

## Endpoint

```
GET https://api.anthropic.com/api/oauth/usage
Authorization: Bearer <oauth-access-token>
anthropic-beta: oauth-2025-04-20
```

- **Token**: read at runtime from `~/.claude/.credentials.json` -> `claudeAiOauth.accessToken`. It is the OAuth token the Claude CLI itself uses, and the CLI refreshes it on use, so it normally stays fresh. Never log or persist it. Per repo security rules, do not hardcode it anywhere.
- **Account details** (auth method, email, org, plan) come from a separate call: `claude auth status --json`, not this endpoint.

## Response shape

One object per window, plus internal codename windows:

```json
{
  "five_hour":         { "utilization": 9,  "resets_at": "2026-06-03T00:00:00Z" },
  "seven_day":         { "utilization": 18, "resets_at": "2026-06-07T18:00:00Z" },
  "seven_day_opus":    null,
  "seven_day_sonnet":  { "utilization": 0,  "resets_at": null },
  "seven_day_oauth_apps": { ... }, "seven_day_cowork": { ... },
  "tangelo": { ... }, "iguana_necktie": { ... }, "extra_usage": { ... }
}
```

- `utilization` is a **plain percent (0-100)**, not a fraction. (Note: the streamed CLI `rate_limit_event` reports the same value as a **0..1 fraction** - watch the scale mismatch.)
- `resets_at` is an ISO string or `null`.
- A window can be `null` (not applicable to the plan) - skip it.

### `limits` array (preferred, 2026-08)

The response now also carries a curated `limits` array - **the only place model-scoped weekly windows (e.g. "Weekly Fable") appear**; the legacy top-level keys never gain new families (`seven_day_opus`/`seven_day_sonnet` stay `null` while the scoped window lives here):

```json
"limits": [
  { "kind": "session",       "group": "session", "percent": 66, "severity": "normal", "resets_at": "...", "scope": null, "is_active": true },
  { "kind": "weekly_all",    "group": "weekly",  "percent": 23, "resets_at": "...", "scope": null },
  { "kind": "weekly_scoped", "group": "weekly",  "percent": 29, "resets_at": "...",
    "scope": { "model": { "id": null, "display_name": "Fable" }, "surface": null } }
]
```

- `percent` is a plain 0-100 integer; `kind` mapping: `session` -> Session (5hr), `weekly_all` -> Weekly (7 day), `weekly_scoped` -> `Weekly <scope.model.display_name>`.
- Parse `limits` first and fall back to the legacy keys only when it is empty/absent (old API responses); skip unknown kinds (overage/promotions may appear).

### Legacy top-level windows
Only these four are real subscription windows among the top-level keys; everything else is an internal codename. **Filter with an allowlist, not a denylist** - new codenames appear over time.

| Key | Label |
|-----|-------|
| `five_hour` | Session (5hr) |
| `seven_day` | Weekly (7 day) |
| `seven_day_opus` | Weekly Opus |
| `seven_day_sonnet` | Weekly Sonnet |

## Failure modes

| Status | Meaning |
|--------|---------|
| 200 | OK |
| 401 | token expired/invalid |
| 403 | access denied |
| 429 | **rate limited - happens fast under repeated calls**, even with a valid token |

**The endpoint rate-limits aggressively.** Cache results (Argus uses a 60s TTL) and treat `429` as transient. Tests that hit it live should tolerate an empty/`429` result rather than fail hard.

## Where Argus uses it

`src/backend/accountUsage.ts` (`fetchUsage`, `parseUsageResponse`). See [tasks/account-and-usage/notes.md](../tasks/account-and-usage/notes.md).
