# ChatMessage memoization

**Status:** deferred
**Area:** `webview/src/components/ChatMessage.tsx`, `MessageList.tsx`

## Problem

`ChatMessage` is not memoized (`export function ChatMessage(...)`). Every time new state arrives (streaming chunk, log entry, context usage update), `MessageList` re-renders and React calls `ChatMessage` for **every message in the list**. For a long session (e.g. 17k-line transcript) this is O(n) markdown + syntax-highlighting work per streaming frame - noticeable as a stutter on long sessions.

## Fix

Wrap `ChatMessage` in `React.memo`:

```tsx
export const ChatMessage = React.memo(function ChatMessage(props: ChatMessageProps) {
  // ...
});
```

For the memo to be effective, props must be stable:
- `message` - already stable (new object only on `done`/`error`/`tool_end` in completed messages)
- `logCount` - currently passed to every `ChatMessage` and changes on every log entry, invalidating the memo for all messages on each log line. **Only pass `logCount` to messages that actually use it** (`background_waiting` outcome, for the `WorkingIndicator`). All other messages can receive `logCount={0}` or omit it.
- `sessionDone` - stable per turn boundary; fine

## Impact

- Standalone performance win for long sessions during streaming (each chunk only re-renders the streaming message, not all prior ones)
- Hard prerequisite for [session-load-progress](session-load-progress.md) (chunked render approach needs O(1) per frame, not O(n))

## Notes

- `logCount` is only consumed by `WorkingIndicator` inside `ChatMessage` (the `background_waiting` outcome path). A conditional prop or a separate `WorkingMessage` component would scope the re-render.
- No visible behavior change; pure performance fix.
