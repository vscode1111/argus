# UI state that must outlive a turn cannot live in the message tree

Anything the user opens and expects to stay open - a preview modal, an expanded panel, an
inline editor, a selection - must not keep its state in a component rendered inside the
message list. Those components are **replaced** at the turn boundary, and React unmounts
them along with whatever they were holding.

## The mechanism

The same tool block is rendered by two different components over its lifetime:

| While the turn runs | After `done` |
|---|---|
| `StreamingMessage` maps `streaming.blocks` | `ChatMessage` maps the committed `UIMessage.content` |

The reducer's `done` clears `streaming` and appends a `UIMessage`, so in one commit React
unmounts the whole `StreamingMessage` subtree and mounts a `ChatMessage` subtree. Same tool
call id, same props, **different component instances** - `useState` inside them starts over.

Two consequences that look like separate bugs but are one:

- State held in a `ToolCall` (a `viewerOpen` flag, a fetched image, a scroll position) is
  destroyed the instant the assistant finishes, i.e. while the user is reading it.
- Anything rendered from streaming *markdown* (a linkified path, a copy button) is
  additionally re-created on every `text_chunk`, because the parsed tree changes shape as
  text arrives.

`createPortal(..., document.body)` does **not** help. The portal changes where the DOM node
is inserted, not who owns the React subtree; the portal's content is unmounted with its
owner exactly the same way. The "Modal portals" convention in CLAUDE.md is about z-index
stacking only and is easy to misread as covering lifetime too.

## The rule

Own the state above the message list - a provider around `AppInner`, with a context method
the block calls (`usePreview().open(req)`). The block keeps only the click handler.

Details that matter when hoisting:

- **Pass a stable `children` element** into the provider (`<PreviewProvider><AppInner /></PreviewProvider>`).
  React then skips re-rendering the subtree when provider state changes, so opening a modal
  does not re-render the message list.
- **Return the same state reference when nothing changes.** A "refresh what is open" method
  called from every block's effect must bail out (`prev.some(...) ? prev.map(...) : prev`),
  or every tool result re-renders the provider.
- **Prefer a stack to a single slot** if the content can contain another trigger (previewed
  markdown linkifies paths too, so a path clicked inside a preview must open on top rather
  than replace what is underneath).
- **Resolve async content in the host, not the trigger.** When the content has to be fetched
  (`readFilePreview` -> `filePreview`), the host owns the round trip and pushes the frame
  only once the reply lands. Doing it in the trigger means the fetch dies with the component
  that started it - and it tends to get copy-pasted per trigger.

## How it presents

The report is "the modal closes by itself during an active session", and the tempting read
is that some event closes it. It is not event-driven: previews survive `text_chunk`,
`tool_start` and even the next turn starting. **Only the commit boundary kills them.** If a
regression spec covers only "survives more streaming events", it passes on the broken code -
the case that matters is `done` arriving while the modal is open.

Found via `e2e/modal-persistence.spec.ts`; full history in
[../tasks/preview-modal-persistence/notes.md](../tasks/preview-modal-persistence/notes.md).
