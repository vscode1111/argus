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

## A URL is not a file path

The path component of a link is indistinguishable from a real path, and `FILE_PATH_RE` will
take it:

| Text | Claimed before the fix |
|------|------------------------|
| `https://192.168.0.12/ui/scripts/main.js` | `/192.168.0.12/ui/scripts/main.js` |
| `http://localhost:3001/webview.js` | `3001/webview.js` |

Both rendered blue with the dotted underline, and clicking opened a preview for a file that
does not exist on this machine.

`linkifyPaths()` therefore matches `URL_RE` (`webview/src/utils/url.ts`, `scheme://` up to the
next whitespace) **first**, renders each hit as a `UrlLink`, and lets the path scan see only
the spans between URLs.

**"Not a file path" is not the same as "not a link".** The URL still has to be clickable, it
just has to open as a URL: `UrlLink` calls `openExternal()`, which posts `openUrl` (VS Code
routes it to `vscode.env.openExternal`) *and* calls `window.open`, matching the login link and
the Account & Usage footer. Both fire unconditionally; the one that does nothing in the current
host is harmless. The click must `preventDefault()` - in browser mode a bare `href` navigates
the Argus page itself away and the conversation view is lost. That applies to prose links too,
so `MarkdownLink` routes `http(s)` through the same helper instead of leaving the href to the
browser.

The two link classes are styled differently on purpose: `.file-path-link` keeps its dotted
underline (a click stays inside Argus and opens a preview), `.external-url-link` is a plain
link that underlines on hover (a click leaves).

Trailing sentence punctuation is trimmed off the match (`trimUrl`), or a URL ending a sentence
swallows the full stop; a closing paren is only punctuation when the URL has no opening one.

The bug was invisible in ordinary prose: remark-gfm autolinks a bare URL into an `<a>` there,
and `withLinkedPaths` skips link elements. It showed only where the autolinker does not
reach - **code spans, fenced blocks, and the plain-text body of a user message** (which is not
markdown at all, so nothing else touches it). Any test for this has to use one of those three,
and should pair the URL with a real path in the same message so that a regression which simply
stops linkifying everything cannot pass.

## Directory segments may contain `!`, filenames should not

The `!notes/` convention means real paths look like `D:\_Projects\CCS\!notes\tasks\x.md`. Both
regexes allow `!` in **directory** segments. The final filename character class deliberately
does not, so ordinary prose (`done!file.md`) is not swallowed into a link.

## The filename suffix accepts hyphens, and may be the whole name

A dotfile is routinely hyphenated (`.corp-account`, `.menu-cms`, and any `.env-*`), so the
suffix is `\.\w+(?:-\w+)*` in both regexes, not `\.\w+`. `\w` excludes `-`, and the failure
mode was not "no link" but **a link to a different file**: in a code span
`C:\...\credentials\.corp-account` linkified as `C:\...\credentials\.corp`, which does not
exist, while in prose `WIN_PATH_RE` missed it entirely and markdown ate the backslashes
around each dot (`C:\Users\Admin.claude\...\credentials.corp-account`). One report, two
symptoms, one cause - a reminder that these two regexes fail differently and both have to
be checked.

`\w` also excludes Cyrillic, which is what keeps a Russian suffix glued to a path
("`.md`-файл") out of the link; an English one ("`readme.md`-based") does join it, the
accepted cost of keeping the two patterns symmetric.

The class before the dot is `*` (not `+`) on the unix and relative branches, so the final
segment may *start* with the dot: `/etc/.gitignore` and `/home/x/.claude/creds/.corp-account`
produced no link at all before that. The Windows branch never had this gap, because its
class includes the separators.

**Still open, and bigger than it looks:** `\w` is ASCII-only, so **no path containing a
non-ASCII segment linkifies at all** - `d:\_Projects\scub111g\people-research\people\tanya-gta\разделы-для-психолога\01-…html`
is inert text in prose and in code spans alike. It stayed invisible because such paths
usually arrive through a tool row, where `ToolCall` renders an `<a>` regardless of this
regex; it surfaced only when a probe tried to open one from prose and timed out. A
`u`-flagged pattern over `\p{L}` in both regexes is the fix, and it needs its own red/green
pass - the character classes appear five times between the two files.

## A directory is a path too (Windows branch only)

*Previously listed here as "still open": a dotless final segment matched a **shorter
prefix** rather than failing, so `C:\Users\Admin\.claude\skills\git-remarks\scripts\`
linked `C:\Users\Admin\.claude` - an existing but entirely different directory. Fixed.*

The extension requirement is dropped **on the Windows branch only**, because the drive
letter is what identifies the text as a filesystem path and nothing else does. The tail is
segments, then a final segment plus an optional separator, with two guards on that final
segment:

- **must not end in a dot**, so a sentence's full stop stays prose (`...\argus\src.`
  links `...\argus\src`) and the elision `C:\...` is not a path;
- **must not be empty**, so a bare `C:\` is not a link either.

```
(?<![a-zA-Z])[A-Za-z]:[\\\/](?:[\w.\-!]+[\\\/])*[\w.\-!]*[\w\-!][\\\/]?
```

`WIN_PATH_RE` widened in step, but deliberately **more loosely**: its final segment stays
optional, so `C:\` and `C:\...` are escaped even though they are not linked. The asymmetry
is the point - the two regexes answer different questions. Escaping asks "would markdown
eat this backslash" (true for both), linking asks "is this worth opening" (false for both).
Over-escaping only makes a backslash visible; under-escaping silently corrupts the text.

### The slash branches were widened the same way and reverted

A URL path in prose is shaped exactly like a directory. Widening unix/relative to accept a
trailing separator passed a 17-case corpus whose bait was `and/or` and `24/7`, then
rendering **one real session** immediately produced links to `/api/probes/` (out of
`GET /api/probes/headers`) and `/api/v4/projects/6829/merge_requests/99/discussions/`.
A leading slash is not evidence of a filesystem, and a bare relative path has no evidence
at all. Reverted; both API paths are now permanent bait in
[../tasks/dir-preview/scripts/probe-live-regex.js](../tasks/dir-preview/scripts/probe-live-regex.js),
which pulls both literals **out of the source files** so it cannot pass against a probe that
has drifted from the shipped code.

The general lesson (a hand-written false-positive corpus is not sufficient evidence for a
widening; render a real transcript and audit every hit) applies to any text-matching rule
here, not just paths.

### Widening the match changes what gets requested

Second-order breakage, easy to miss: the link now carries a trailing separator, the host
resolves it away, and `got.endsWith(wanted)` therefore **rejected the answer to its own
question** - the preview spun until its 20s timeout. Fixed by `matchesRequestedPath()` in
`webview/src/utils/path.ts`, used by both `PreviewContext` and `FileViewerModal`. When
changing what these regexes match, re-check every matcher keyed on the resulting string.

Still open from the same family: a dotless final segment on the **unix and relative**
branches still fails to link at all (only the Windows branch was widened). Recorded in
[../tasks/hyphen-in-filename-truncates-link/notes.md](../tasks/hyphen-in-filename-truncates-link/notes.md)
and [../tasks/dir-preview/notes.md](../tasks/dir-preview/notes.md).

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
