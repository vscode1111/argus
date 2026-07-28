# Streaming fix + model config decoupling + input UI restyle

Worked on `main` (no ticket). Three related improvements driven by user observations during a live session:

1. Argus dumped long responses as one block after a long delay instead of streaming.
2. The model name was hardcoded in five places, making each Anthropic model release a chore.
3. The Send/Stop buttons looked nothing like the original Claude Code UI.

## Streaming was effectively disabled

### Symptom
When asked for a long response (200+ chars), the UI showed a "Working..." indicator for several seconds then dropped the whole answer at once - no per-token streaming. The native Claude Code CLI streams visibly. The official Anthropic API streams. So the gap had to be in Argus.

### Investigation
1. `cliHandler.ts` already had a `handleDelta` function and a dispatch on `event.type === 'content_block_delta'`. So the wiring existed.
2. Captured raw CLI output by running `echo '{"type":"user",...}' | claude --print --verbose --output-format stream-json --input-format stream-json` directly. **No** `content_block_delta` events came out - only one `assistant` event at the end.
3. Re-ran with `--include-partial-messages`. The CLI then emitted `stream_event` envelopes wrapping the inner deltas. **The flag was the trigger for per-token streaming.**
4. Even after adding the flag, the dispatch missed the events because they arrive wrapped: `{"type":"stream_event","event":{"type":"content_block_delta","delta":{...}}}`. The handler was matching on the outer type only.

### Fix
- [src/backend/session.ts:213](../../../src/backend/session.ts#L213) - added `--include-partial-messages` to the CLI spawn args.
- [src/backend/cliHandler.ts:31-33](../../../src/backend/cliHandler.ts#L31-L33) - added a branch that unwraps `stream_event` and dispatches the inner `content_block_delta` event.

### Regression coverage
New integration test [e2e/streaming-partial-integration.spec.ts](../../../e2e/streaming-partial-integration.spec.ts) intercepts the WebSocket frames via Playwright's `page.on('websocket')` (not DOM mutations - React 18 batches re-renders so DOM-level sampling collapses chunks). Sends a prompt asking for numbers 1..80, asserts the response arrives as >= 3 `text_chunk` frames with no single chunk > 70% of the total length. Without the fix, the test sees exactly 1 frame of full size.

The new test ran 1 -> 3 chunks of ~230 chars total once the fix was in place, with the largest chunk being ~42% of the response.

## Decisions

### Drop the model default from package.json schema

The model name was hardcoded in:
- `package.json` (`default` + `enum`)
- `src/frontend/utils/config.ts` (`??` fallback)
- `server/index.ts` (env var fallback)
- `src/backend/index.ts` (`DEFAULT_MODEL` fallback)
- `e2e/image-recognize-integration.spec.ts` (assertion)

Five places to update per Anthropic release - painful. Resolution:
- Removed `default` and `enum` from `argus.model` in package.json - free-text field now.
- All code fallbacks resolve to `''` (empty string).
- [src/backend/session.ts:216](../../../src/backend/session.ts#L216) - `--model` is now passed only when `s.model` is non-empty. **When the user doesn't pick a model, the Claude CLI uses its own current default.** Argus tracks the CLI version's default automatically.
- E2e assertion changed from `'claude-opus-4-6'` to regex `/claude-(opus|sonnet|haiku)-\d+-\d+/`.
- `inlineCompletions.model` keeps its `claude-haiku-4-5` default - inline completions specifically need a fast/cheap tier, so deferring to CLI default is wrong there.

### Send/Stop button restyle

User wanted them to match the original Claude Code icon style. Final design:
- Both buttons use inline SVG icons (Send: ↑ arrow with rounded strokes, Stop: rounded filled square). `currentColor` stroke/fill so they inherit theme tokens.
- Both buttons have `aria-label="Send"` / `aria-label="Stop"` - this is the key for Playwright tests that already use `getByRole('button', { name: 'Send' })`.
- New `.sendRow` flex container holds both. `align-self: stretch` matches the width of the top button row (mode pill, context %, settings gear).
- Both buttons have `flex: 1`. When Stop is hidden (idle): Send fills the row with a `min-width: 70px` floor matching the original "Send" text button width. When Stop is visible (streaming): they split 50/50.
- Send is on the left, Stop on the right - user-requested order.

### Bug spotted but not fixed: 529 misclassified as auth

In [src/backend/cli.ts:54](../../../src/backend/cli.ts#L54), `classifyError` blindly returns `errorKind: 'auth'` when `exitCode === 1 && text` is non-empty. This causes 529 Overloaded errors (which exit with code 1) to be rendered with the "Authentication required" header and a Login button.

**Not patched this session.** Suggested fix would be a `GENERIC_PATTERNS` list (e.g., `/API Error:/i`, `/overloaded/i`, `/\b5\d\d\b/`, `/429/`) that wins before the auth fallback, plus dropping the over-broad exit-code-1 catch-all. Document for the next pass.

## Gotchas

- **CLI envelope format**: deltas come as `{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"..."}}}`. The outer wrapper is `stream_event`. Don't add a handler on `content_block_delta` directly - it won't fire because the CLI doesn't emit that as a top-level type when `--include-partial-messages` is on.
- **DOM-level streaming tests are flaky**: React 18 batches re-renders, so multiple `text_chunk` frames received in the same microtask collapse into a single MutationObserver event. The streaming integration test was rewritten 3 times before settling on WS-frame interception, which is deterministic.
- **Both Send and Stop are visible during streaming** (send-while-streaming feature). Tests that wait for completion can't use `getByRole('button', { name: 'Send' })` as a "streaming done" signal because Send is always there. Use `getByRole('button', { name: 'Stop' }).toHaveCount(0)` instead.
- **Don't restart the dev server with `yarn dev` from inside the agent.** It's a long-running process. Use `node scripts/dev-stop.js` to stop it; Playwright will start a fresh one on next test run because `playwright.config.ts` has `reuseExistingServer: true`.
- **Opus 4.6 was overloaded during this session.** Several flaky test retries and live UI failures were caused by 529 errors. If a session keeps hitting this, switch via `$env:ARGUS_MODEL="claude-opus-4-7"` before launching dev.

## Files changed

| Path | What |
|------|------|
| `src/backend/session.ts` | Added `--include-partial-messages` to spawn args; conditional `--model` flag (only when non-empty) |
| `src/backend/cliHandler.ts` | Unwrap `stream_event` envelope to dispatch inner `content_block_delta` |
| `src/backend/index.ts` | `DEFAULT_MODEL` fallback `'claude-opus-4-6'` -> `''` |
| `server/index.ts` | `MODEL` env fallback `'claude-opus-4-6'` -> `''` |
| `src/frontend/utils/config.ts` | `getModel()` fallback `'claude-opus-4-6'` -> `''` |
| `package.json` | `argus.model` lost `default` and `enum`; free-text now |
| `webview/src/components/InputArea.tsx` | Send/Stop -> SVG icons + aria-labels; new `.sendRow` container; Send-then-Stop order |
| `webview/src/components/InputArea.module.css` | `.btnSend`/`.btnStop` -> `flex: 1`, 34px height; `.sendRow` `align-self: stretch`; Send has `min-width: 70px` |
| `e2e/streaming-partial-integration.spec.ts` | New file - asserts >= 3 text_chunk WS frames with no dominant chunk |
| `e2e/image-recognize-integration.spec.ts` | Hardcoded model string -> regex |
| `README.md`, `CLAUDE.md` | Updated model default docs and added Token streaming / Send-Stop convention entries |
