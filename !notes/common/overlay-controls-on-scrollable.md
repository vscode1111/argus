# Overlay controls anchored over a scrollable region

Any hover control parked in the corner of something that scrolls (the code-block copy
button, and anything similar added later over `DiffViewerModal`'s `.scroll`, the file
previewer body, or `ToolCall`'s `pre.toolInput`) must live in a **non-scrolling wrapper**.
Do not make one element both the scroll container and the positioning context.

## The mechanism

An absolutely positioned child of a scroll container is laid out against that container's
padding box **at scroll origin**, and then it scrolls with the content like everything
else inside. So `position: absolute; top: 4; right: 4` is correct only while
`scrollLeft === 0`; every pixel of horizontal scroll carries the control left by the same
amount, until it leaves the visible area entirely.

The intuition that trips people here is that `right: 4` will pin the element to the
element's *scrollable* right edge (i.e. park it at the end of the longest line, off-screen
to the right, and drift it *into* view as you scroll). Measured in Chrome, it does the
opposite. On a 4706px-wide code block in a 1020px pane:

| `scrollLeft` | control's right edge |
|---|---|
| 0 | x = 1028 (4px inside the block, correct) |
| 3687 | x = **-2659** (off-screen left) |

## The shape that works

```tsx
// wrapper: positioning context, does NOT scroll
<div className="code-block-wrapper" style={{ position: 'relative', width: 'fit-content', maxWidth: '100%' }}>
  <pre style={{ overflowX: 'auto', /* background, padding, radius */ }}>{children}</pre>
  <CopyButton />   {/* absolute; anchored to the wrapper, so it never moves */}
</div>
```

`width: fit-content` + `max-width: 100%` moves to the wrapper and behaves identically:
a scroll container still contributes its content's max-content size to the parent's
intrinsic sizing, so a long line makes the wrapper hit `max-width` (fill the pane) while a
short block still hugs its content.

Two consequences worth keeping:

- The control now sits permanently **over** code that scrolls beneath it, so it needs an
  opaque background (`var(--tool-bg)`, matching the block) rather than `transparent`.
- The hover CSS keys off the wrapper class (`.code-block-wrapper:hover .code-copy-btn` in
  `global.css`), so the class moves to the wrapper div and the CSS needs no change.

## Verifying a fix like this

Measure both states, and run the control: re-nest the button inside the scroll container
from DevTools and confirm the drift comes back. Otherwise it is easy to "fix" a layout by
coincidence and record a wrong explanation - which is what happened here, the first
write-up of this bug had the drift direction backwards until the control run contradicted
it.

```js
const wrap = document.querySelector('.code-block-wrapper'), pre = wrap.querySelector('pre');
const btn = wrap.querySelector('.code-copy-btn');
const box = () => Math.round(btn.getBoundingClientRect().right - wrap.getBoundingClientRect().right);
pre.scrollLeft = 0;              box();   // expect ~-4
pre.scrollLeft = pre.scrollWidth; box();  // expect ~-4 too; a large negative number is the bug
```

Origin: [../tasks/code-block-copy-button/notes.md](../tasks/code-block-copy-button/notes.md).
Regression test: `e2e/code-copy-button.spec.ts`.
