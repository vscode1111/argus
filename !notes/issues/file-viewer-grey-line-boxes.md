# Issue: FileViewerModal renders a grey box behind every line (extension only)

Status: **resolved / verified in extension**
Area: `FileViewerModal` -> SyntaxHighlighter line rendering
First captured: 2026-06-19

## Symptom

Opening a file in `FileViewerModal` (`webview/src/components/FileViewerModal.tsx`)
showed a faint grey box behind **every** code line (lines 1-4, 6-15, ...), not
just the highlighted target line. The boxes appeared **only in the VS Code
extension**, never in the browser dev server (`yarn dev`), which made the bug
invisible during normal frontend iteration.

## Root cause (VS Code injects a default webview stylesheet)

The grey was the `<code>` element's own `background`, computed as `rgb(38,38,38)`
(~`#262626`). It is **not** part of the `vscDarkPlus` Prism theme. VS Code
injects a default stylesheet into every webview that fills `code` elements with a
code-block background. That fill is lighter than the editor background, so it
read as a box behind each line. The browser dev server has no such injection,
which is exactly why the bug was extension-only.

The component's `customStyle={{ background: 'transparent' }}` only covers the
`<pre>` wrapper, never the inner `<code>`, so the injected `code` background was
never overridden.

## Hard evidence (in-extension diagnostic, not a guess)

Two earlier theories were wrong. The breakthrough was reading the **real
computed styles from inside the extension webview** via a temporary on-screen
diagnostic (the browser could not reproduce it). A full-resolution screen
capture of the Extension Host printed:

```
line=rgba(0,0,0,0) | token=rgba(0,0,0,0) | code=rgb(38,38,38) | pre=rgba(0,0,0,0) | selRanges=0
```

Reading: `selRanges=0` kills the text-selection theory; `line`/`token`/`pre`
backgrounds are all transparent; the only painted element is `<code>` at
`rgb(38,38,38)`. That `<code>` fill is the box.

## Attempts

### Attempt 1 - full-width highlight band (wrong theory)
Assumed the boxes were the intended line highlight bleeding across all rows.
Adjusting the highlight band did nothing to the grey boxes. Wrong: the highlight
is correctly scoped to one line; the grey was a separate element background.

### Attempt 2 - clear text selection via `removeAllRanges()` (wrong theory)
Assumed a stray text selection painted the rows. Added a selection-clear on
open. The boxes remained, and the diagnostic later showed `selRanges=0`, proving
there was never a selection. Reverted.

### Attempt 3 - override the `<code>` background inline (RESOLVED)
`codeTagProps={{ style: { background: 'transparent' } }}` on the
`SyntaxHighlighter`. An inline style on the `<code>` element beats VS Code's
injected stylesheet (which `customStyle` on the `<pre>` cannot reach).
**Result: verified** in the Extension Development Host - the grey boxes are gone,
the code area is a clean uniform background, and only the target line carries the
highlight (faint band + left accent bar). The disproven selection-clear and the
temporary diagnostic were removed. 23 mock e2e tests pass
(`e2e/file-viewer-modal.spec.ts`, `e2e/file-path-links.spec.ts`).

## Lesson (generalizable)

**The browser dev server is not proof for an extension-only rendering bug.** VS
Code injects CSS that the dev server does not, so a whole class of "looks fine in
`yarn dev`, broken in the extension" rendering bugs can only be diagnosed and
verified inside the Extension Host. When computed styles disagree with the theme,
suspect the injected webview stylesheet and override the specific element inline.

## Touched files

- `webview/src/components/FileViewerModal.tsx` - `codeTagProps` background transparent; removed selection-clear and diagnostic
- `webview/src/global.css` - `.highlighted-line` single-line band + left accent bar (scoped under `.fileViewerBody`)
- `CLAUDE.md` - "Clickable file paths" bullet records the root cause and fix
- `e2e/file-viewer-modal.spec.ts`, `e2e/file-path-links.spec.ts` - coverage
