# Model context windows

Where a model's context window comes from, which sources lie about it, and how the official
client turns it into a percentage. Needed by anything that reports context fill, estimates
remaining room, or reasons about when the CLI will compact.

## Source of truth: `/v1/models`

```
GET https://api.anthropic.com/v1/models?limit=50
Authorization: Bearer <oauth-access-token>
anthropic-beta: oauth-2025-04-20
anthropic-version: 2023-06-01
```

Token source and handling are the same as the usage API - see
[oauth-usage-api.md](oauth-usage-api.md).

Each entry carries `max_input_tokens` (the context window) and `max_tokens` (max output).
Observed 2026-08-11:

| Model | `max_input_tokens` | `max_tokens` |
|---|---|---|
| claude-opus-5, claude-sonnet-5, claude-fable-5 | 1,000,000 | 128,000 |
| claude-opus-4-8, claude-opus-4-7, claude-opus-4-6, claude-sonnet-4-6 | 1,000,000 | 128,000 |
| claude-sonnet-4-5-20250929 | 1,000,000 | 64,000 |
| claude-opus-4-5-20251101, claude-haiku-4-5-20251001 | 200,000 | 64,000 |

`fetchModels()` in `src/backend/accountUsage.ts` keeps this as `ModelInfo.contextWindow`, and it
is persisted into `modelListCache` in `argus.json` by the daily model-data refresh.
`contextWindowFor()` in `src/backend/modelData.ts` reads it back.

## The window is not derivable from the model family

`claude-opus-4-5` is 200k while `claude-opus-4-6` and everything after it is 1M. Same family,
different window. Any `id.includes('opus') -> 1M` shortcut is wrong for half the opus line, so an
unknown id must fall back to a default (200k) rather than guess. This is the one place where the
family-substring classifier used for descriptions (`modelFamily()`) must **not** be reused.

Ids in the list may or may not carry a `-20\d{6}` snapshot date, and the id the CLI reports in
`event.message.model` may differ from the cached one in exactly that suffix, so matching strips the
date from both sides.

## The CLI's own report is unreliable for new models

The CLI's `result` stream event carries `modelUsage[<model>].contextWindow`. It is tempting as a
free, per-turn source. Do not use it: the CLI resolves the window from a **registry baked into its
own bundle**, and an id missing from that registry silently takes the 200k default rather than
erroring. Verified against CLI 2.1.197 with real turns:

- `claude-sonnet-5` -> `contextWindow: 1000000` (present in the registry, correct)
- `claude-opus-5` -> `contextWindow: 200000` (**wrong**; the id does not appear anywhere in the exe)

So the value is right exactly when you did not need it, and wrong for any model released after the
installed CLI - which is the case that matters. `/v1/models` wins.

The registry itself is greppable (technique: [cli-bundle-mining.md](cli-bundle-mining.md)) as
`{id:"claude-sonnet-5",...,context:{window:1e6,native_1m:!0,supports_1m_beta:!0,...}}`, resolved by
a `jxi(model, betaHeaders)` chain that falls through to a `200000` default constant.

## The window is only as fresh as the last successful refresh, and the fallback is silent

`contextWindowFor()` does not call `/v1/models`; it reads `modelListCache` from `argus.json`,
which the daemon fills on its daily refresh. So the pill depends on a cache that can go stale, and
the failure is **silent in the direction that hurts**: an id missing from the cache returns
`DEFAULT_CONTEXT_WINDOW` (200k), which on a 1M model reports a percentage five times too high.
Nothing in the UI distinguishes "the window is 200k" from "I do not know the window".

Two consequences when a percentage looks wrong:

- Check `modelDataUpdatedAt` and the cache contents before suspecting the arithmetic. A genuine
  cache hit and a fallback produce identical output, so compare the id against `modelListCache`
  rather than reading the number:

  ```bash
  node -e 'const c=require(require("os").homedir()+"/.claude/argus.json");
    console.log(c.modelDataUpdatedAt&&new Date(c.modelDataUpdatedAt).toISOString());
    for(const m of c.modelListCache||[]) console.log(m.id, m.contextWindow??"(none)")'
  ```

- A refresh whose `/v1/models` fetch failed keeps the previously cached windows rather than
  blanking them, which is why a stale cache is usually *right*. It is a brand-new model, absent
  from a cache that predates it, that falls back.

Refresh scheduling and the two clocks that bound how long a failure can hide this:
[../tasks/model-refresh-retry-backoff/notes.md](../tasks/model-refresh-retry-backoff/notes.md).

## The official percentage excludes output tokens

From the same bundle:

```js
function cIn(e,t){
  let n = e.input_tokens + e.cache_creation_input_tokens + e.cache_read_input_tokens,
      r = Math.round(n/t*100);
  return { used: Math.min(100, Math.max(0, r)), remaining: 100 - r };
}
```

Input plus both cache counters, over the window. `output_tokens` is **not** in the numerator: it is
already counted in the next request's input, so adding it double-counts.

## Context fill is not a compaction signal

Auto-compaction is entirely the CLI's own business. Argus never triggers it and has no hook into
it, so a context percentage displayed in the UI is informational only. A wrong percentage therefore
surfaces to the user as "the bar says 100% but nothing compacts", which reads like a broken trigger
and is not one.

Open, not understood: the CLI did not compact a `claude-opus-5` session at 337k tokens even though
its own registry believes that model's window is 200k. Either auto-compaction behaves differently
in `--print` mode or the threshold path uses a source other than that registry. It costs nothing
today (the real window is 1M), but the compaction point for a model newer than the installed CLI
should not be assumed.
