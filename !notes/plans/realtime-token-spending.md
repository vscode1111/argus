# Plan: Real-time token spending during an active session

## Current state

- `contextUsage` (the `%` pill in InputArea) is only updated after a turn ends,
  from the `assistant` event's `usage` field in `handleAssistant()`.
- During streaming: only elapsed time is shown (`StreamingTimer`).
- `ThinkingBlock` shows raw text, no token count.

## Two sources of live data

| Source | When | Accuracy | Backend change? |
|--------|------|----------|-----------------|
| Character count of received chunks | Per chunk | Rough (~chars/4) | No |
| `message_start` / `message_delta` stream events | Per API event | Exact | Yes |

---

## Step 1 - ThinkingBlock: immediate character-based estimate (frontend only)

`ThinkingBlock` already receives the live `text`.
Show `Math.ceil(text.length / 4)` as a label in the collapsed header:

```
Thinking...  81 tokens  >
```

- No WS change, no backend change.
- Updates live on every `thinking_chunk`.
- Collapsed view shows the count; expanded view shows full text.

**Files:** `webview/src/components/ThinkingBlock.tsx`, `ThinkingBlock.module.css`

---

## Step 2 - Backend: parse `message_start` and `message_delta` from `stream_event`

The Anthropic API emits these inside the `stream_event` envelope
(alongside `content_block_delta`):

- `message_start` -> `{ message: { usage: { input_tokens: N } } }` - prompt cost at turn start
- `message_delta` -> `{ usage: { output_tokens: N } }` - cumulative output count, sent periodically

In `cliHandler.ts`, extend the `stream_event` handler:

```ts
} else if (event.type === 'stream_event') {
  const inner = event.event as Record<string, unknown> | undefined;
  if (inner?.type === 'content_block_delta') handleDelta(s, inner);
  else if (inner?.type === 'message_start') handleMessageStart(s, inner);
  else if (inner?.type === 'message_delta') handleMessageDelta(s, inner);
}
```

New WS message: `token_update { inputTokens?: number; outputTokens?: number }`

**Files:** `src/backend/cliHandler.ts`, `src/backend/sessionState.ts`

---

## Step 3 - Frontend: `liveTokens` in `StreamingState`

Add to `types.ts`:

```ts
// StreamingState gets:
liveTokens?: { input: number; output: number };
```

Add `token_update` to `AppAction` in `reducer.ts`:
- On `message_start` message: set `streaming.liveTokens.input`
- On `message_delta` message: update `streaming.liveTokens.output`

**Files:** `webview/src/types.ts`, `webview/src/reducer.ts`

---

## Step 4 - Display in StreamingTimer / StreamingMessage

Pass `liveTokens` from `streaming` to `StreamingTimer` and show inline:

```
12s (3s idle)  ·  1.2k out  /  48k in
```

Or a subtle `tokenPill` span beside the timer, same muted style as the context pill.

**Files:**
- `webview/src/components/StreamingTimer.tsx`
- `webview/src/components/StreamingMessage.tsx`
- `webview/src/components/shared/message.module.css`

---

## Priority order

1. **ThinkingBlock token count** (Step 1) - frontend-only, one component, immediate win
2. **`token_update` WS message** (Steps 2+3) - backend + reducer plumbing for exact counts
3. **StreamingTimer display** (Step 4) - wires the data into the visible timer

Steps 1 and 2-4 are independent and can be done in parallel.
