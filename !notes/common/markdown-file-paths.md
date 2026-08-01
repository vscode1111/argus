# File paths in rendered markdown

How Argus turns file paths in model output into clickable links, and the constraints any
change to that pipeline has to respect. Applies to every ticket that touches
`webview/src/utils/filePath.tsx` or `webview/src/utils/markdown.tsx`.

## Two regexes, two jobs, keep them in sync

| Regex | File | Job |
|-------|------|-----|
| `WIN_PATH_RE` | `markdown.tsx` | Escape backslashes **before** the markdown parser runs, so `D:\_Projects` does not become `D:_Projects` (the parser treats `\` as an escape char) |
| `FILE_PATH_RE` | `filePath.tsx` | Find paths in the already-parsed text and wrap them in `FilePathLink` |

They run in sequence on the same text, so a character class that one accepts and the other
rejects produces a half-linked path. When widening either one, widen both and add a case to
`e2e/file-path-bang-folder.spec.ts` (or a sibling spec).

## Escaping must skip code spans and fences

Backslashes are already literal inside `` `code` `` and fenced blocks. Running the escape pass
over them yields a visible doubled backslash (`CCS\\!notes`). `protectPathBackslashes` splits
the input on `CODE_SPAN_RE` and escapes only the text between matches. Any new pre-parse text
transform needs the same treatment.

## Directory segments may contain `!`, filenames should not

The `!notes/` convention means real paths look like `D:\_Projects\CCS\!notes\tasks\x.md`. Both
regexes allow `!` in **directory** segments. The final filename character class deliberately
does not, so ordinary prose (`done!file.md`) is not swallowed into a link.

## Relative links are only navigable inside the previewer

`Markdown` renders `<a>` through `MarkdownLink`, which asks `usePreviewNav()` for a navigate
callback:

- **Inside `FileViewerModal`** the callback is provided (`PreviewNavContext.Provider`), so a
  relative href loads the sibling document into the previewer's frame stack.
- **Anywhere else** (chat messages) the context is `null` and a relative href is dropped, as
  it always was - there is nothing to navigate. Only `http(s)`, `#`, and `mailto:` keep an
  href.

So a link's behavior depends on where it is rendered, not on the href alone. Test both
contexts when changing `MarkdownLink`.

## Linkification is length-capped

`linkifyPaths()` skips strings over `MAX_LINKIFY_LENGTH` (5000 chars) to avoid regex
backtracking on adversarial model output. A very long assistant message will legitimately show
unlinked paths.

## Testing the previewer

The modal overlay is `aria-hidden`, so `getByRole('link')` and friends cannot see inside it.
Locate through `[role="dialog"]` with tag/class locators instead. See
[e2e-testing.md](e2e-testing.md) for the general e2e conventions.
