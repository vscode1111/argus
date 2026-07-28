# Determinate progress bar for session resume / workspace switch

**Status:** idea / not started
**Area:** `webview/src/App.tsx`, `webview/src/components/MessageList.tsx`, `ChatMessage.tsx`, `global.css`

## Motivation

Resuming a large session (e.g. the 17k-line "Optimize message fetching" one) or
switching workspace takes a few seconds. Today a plain indeterminate spinner
overlay (`.sessionLoader` / `.sessionSpinner`) covers the chat pane while the
resume is in flight (added in the "Add spinner similar when app is loading" change).

The user asked: can we calculate the session length and show a real **progress
of loading** (a determinate bar), not just a spinner?

## Where the time actually goes

For a resume the flow is: backend `loadSession()` reads + parses the whole
`.jsonl` transcript -> sends one `sessionLoaded {id, messages}` WS frame -> the
reducer replaces `messages` all at once -> React renders the entire `MessageList`.

The dominant cost is the **final React render** (markdown + syntax highlighting of
many messages), not the backend parse or the WS transfer. So a determinate bar is
only honest if it tracks the **render**, not the transfer.

## Proposed approach: chunked render

Render the replayed messages in batches across animation frames and drive a
determinate bar off how many are rendered.

1. Stop dispatching `sessionLoaded` all at once. Remove `sessionLoaded` from the
   auto-dispatch `VALID_TYPES` set in `App.tsx` and handle it manually in
   `onSessionMsg`.
2. Keep the indeterminate spinner for the "waiting for data" phase (backend parse
   + WS transfer, before `sessionLoaded` arrives).
3. On `sessionLoaded`, switch to a determinate bar and reveal the messages in
   chunks (e.g. `CHUNK = 15`) via `requestAnimationFrame`: each frame dispatch
   `sessionLoaded` with `all.slice(0, i)` and set `loadProgress = { loaded: i, total }`.
   `pct = round(loaded / total * 100)`. Small sessions (`total <= CHUNK`) skip
   straight to a single dispatch.
4. On completion clear `loadProgress` and end the load (hide overlay). Cancel the
   in-flight rAF on unmount and if a new reveal starts.

### Hard prerequisite: memoize `ChatMessage`

Growing the slice each frame re-renders `MessageList`. `ChatMessage` is **not**
memoized today (`export function ChatMessage(...)`), so every prior message would
re-render every frame -> O(n^2) markdown rendering, which is worse than the status
quo. Wrap it: `export const ChatMessage = React.memo(ChatMessageInner)`. With
stable `message` object refs (same objects across the growing slices) and stable
`logCount` during the reveal window, already-shown messages skip re-render, so each
frame only renders the new `CHUNK`.

Caveat: `logCount` is a prop on every `ChatMessage`; while logs are flowing it
changes and would invalidate the memo for all messages. It is effectively stable
during the brief reveal (no streaming mid-resume), so this is fine for the reveal,
but consider only passing `logCount` to the messages that use it
(`background_waiting` `WorkingIndicator`) to avoid unrelated re-renders generally.

## UI

Reuse the `.sessionLoader` overlay. When `loadProgress` is set, render a track +
fill bar (`.sessionProgress` / `.sessionProgressBar`) plus a `NN%` label; otherwise
fall back to the spinner. Bar fill = `${pct}%` width.

## Notes / caveats

- The bar is "real" (tracks committed renders) but still **chunky** - markdown
  rendering is the cost, and it advances per frame-batch, not smoothly.
- `MessageList`'s autoscroll effect fires on each `messages` change, so it stays
  pinned to the bottom through the reveal (fine; it happens behind the overlay).
- Progress granularity is per-message-count. Could instead weight by each message's
  line count (we already compute per-session `lines`) for a bar that tracks content
  volume, but message-count is simpler and close enough.
- Workspace switch without a resume has no transcript to render (empty pane), so it
  stays on the spinner until the post-reconnect `sessionList` lands - no bar needed.

## Decision log

- 2026-06-24: user picked "Real % via chunked render" over a size-labelled spinner
  or an indeterminate animated bar, then deferred it as too big a change for now and
  asked to capture it here as a to-do.
