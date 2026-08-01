# File previewer navigation + path-linkification fixes

Version 0.0.79.

## Problem

Three separate defects, all around previewing and linking files from chat output:

1. **Markdown links inside a previewed document were inert.** Opening a doc such as
   `!notes/INDEX.md` in `FileViewerModal` rendered its relative links (`[common/](common/)`,
   `[notes.md](../../../x/notes.md)`) as dead `<a>` with no `href` - the previewer showed an
   index nobody could follow. The index docs this repo relies on are exactly the case where
   navigation matters most.
2. **Paths through a `!notes` folder were mangled.** `D:\_Projects\CCS\!notes\tasks\x.md`
   rendered as `CCS!notes\tasks\x.md` (backslash eaten by the markdown parser) and only the
   tail after the bang became a link. Both regexes involved excluded `!` from their character
   classes, so the escape pass stopped at the bang and the linkifier started after it.
3. **A transcript with `AskUserQuestion.questions` recorded as a JSON string crashed the app.**
   `input.questions` was cast to an array and iterated; a string made `.map` throw inside
   render, which unmounts the whole React tree (blank panel, not a broken block).

Also: the previewer's "Open in editor" button was rendered in browser mode, where the
`openFile` message has no handler - a silent no-op.

## Changes made

**In-preview navigation (`FileViewerModal.tsx`, `contexts/PreviewNavContext.ts`)**

- `FileViewerModal` keeps a `Frame[]` stack (`{path, content, line}`). The `path`/`content`
  props are the root frame; an empty stack means the caller's document is showing. A new
  `path` prop resets the stack (the user clicked a different path in chat, so the trail is
  no longer meaningful).
- `navigate(href)` resolves the href against the current document's directory, posts
  `readFilePreview`, and a scoped `message` listener pushes the reply onto the stack. The
  listener matches on `pendingPath` (with an `endsWith` fallback, because the backend may
  answer with a resolved absolute path).
- A Back button (`BackIcon`, Feather arrow-left) appears in the header only when the stack is
  non-empty. Each followed document resets `scrollTop` to 0.
- `PreviewNavContext` carries the navigate callback down to the markdown renderer. It is
  `null` everywhere outside the previewer, which is what keeps chat-message links behaving
  exactly as before.
- `MarkdownLink` in `markdown.tsx` replaces the inline `a` renderer: external schemes
  (`http(s)`, `#`, `mailto:`) keep their href as before; a relative href navigates the
  previewer **only when the context is present**.
- "Open in editor" is now gated on `isVsCode`.

**Path linkification through `!` folders (`filePath.tsx`, `markdown.tsx`)**

- `FILE_PATH_RE`: `!` added to the *directory* character classes only. The final filename
  class deliberately still excludes it, so prose like `done!file.md` is not swallowed.
- `WIN_PATH_RE`: widened to cover relative backslash paths (previously drive-letter only) and
  to allow `!` in segments.
- `protectPathBackslashes` now splits code spans/fences out via `CODE_SPAN_RE` and escapes
  only the text between them. Backslashes are already literal inside code, so escaping there
  produced a visible doubled `CCS\\!notes`.

**AskUserQuestion string input (`ToolCall.tsx`)** - `questions` is parsed when it is a string,
and the result is `Array.isArray`-guarded before use.

## Files changed

- `webview/src/components/FileViewerModal.tsx` - frame stack, `navigate`, Back button, `isVsCode` gate, exported `resolveRelative`
- `webview/src/contexts/PreviewNavContext.ts` - new
- `webview/src/utils/markdown.tsx` - `MarkdownLink`, code-span-aware escaping, widened `WIN_PATH_RE`
- `webview/src/utils/filePath.tsx` - `!` in directory segments of `FILE_PATH_RE`
- `webview/src/components/ToolCall.tsx` - stringified `questions` guard
- `webview/src/components/shared/icons.tsx` - `BackIcon`
- `e2e/preview-navigation.spec.ts` + `e2e/fixtures/` (`preview-root.md`, `preview-child.md`, `sub/preview-nested.md`) - new
- `e2e/file-path-bang-folder.spec.ts`, `e2e/ask-dialog-string-input.spec.ts` - new
- `e2e/file-path-links.spec.ts` - minor
- `package.json` - 0.0.78 -> 0.0.79

## Key code paths

- Navigation entry point: `FileViewerModal.navigate` -> `postMessage({type:'readFilePreview'})` -> `filePreview` reply -> `setStack`
- Link rendering decision: `markdown.tsx` `MarkdownLink` + `usePreviewNav()`
- Path resolution: `FileViewerModal.resolveRelative(basePath, href)` (exported, handles `./`, `../`, keeps the base path's separator style)

## Gotchas

- **The modal overlay is `aria-hidden`, so role-based Playwright locators cannot see inside
  it.** The spec had to locate through `[role="dialog"]` with class/tag locators instead of
  `getByRole('link')`. Worth knowing before writing any new previewer test.
- **Escaping Windows paths inside code spans doubles the backslashes.** The first fix widened
  `WIN_PATH_RE` alone, which made inline code render `CCS\\!notes`. The misleading signal was
  that the non-code case looked correct, so the regex seemed right; what disproved it was a
  test rendering the same path inside backticks. The escape pass has to skip code spans.
- **A throw inside a tool renderer takes down the whole panel, not just the block.** The
  `AskUserQuestion` crash presented as "the app is blank", which reads like a WS or mount
  problem, not a data-shape problem in one transcript.

## Verification

- `e2e/preview-navigation.spec.ts` - 5 tests (follow relative link, Back, subfolder + `..`,
  external link keeps href, no "Open in editor" in browser mode)
- Full mock project: 170 passed
- `tsc --noEmit` on the webview reports two errors (`endLine` missing on `FileViewerModal`
  Props; `SyntaxHighlighter` JSX typing) - both pre-exist at HEAD, unrelated to this change

## Remaining work

- Not committed yet.
- The pre-existing `endLine` prop mismatch is still there: `filePath.tsx` passes `endLine` to
  `FileViewerModal`, whose `Props` has no such field. Harmless (the value is unused) but it
  keeps `tsc` red.

See [../../common/markdown-file-paths.md](../../common/markdown-file-paths.md) for the
durable rules about the two path regexes and the escape pass.
