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

## `@` is a filename character, and both branches need it

`out\@snowy_137.json` (a per-handle dump) linked only `out\`. Because a directory is a
valid target on the Windows branch, a final segment the class rejects does not fail the
match - it falls back to **the longest directory prefix**, which exists, so the click
opened a folder listing and nothing looked broken. Same failure shape as `.corp-account`,
same lesson: a too-narrow class here produces a wrong target, not a missing link.

Asymmetric on purpose:

- **Windows branch: `@` anywhere.** The drive letter is the evidence, and an address
  cannot appear after one. Required by the mid-segment cases, which are routine:
  `garland@2x.png` and friends (retina assets), `browser@6e474dac…` (ms-playwright).
- **Unix and relative branches: in a directory segment, and only at the *start* of the
  final one (`@?`).** That is where a scoped package name puts it, while an address puts
  it in the middle - so `docs/john@corp.com` stays prose.

Without it on the slash branches, `/home/u/node_modules/@types/node/index.d.ts` fell
through to the *relative* branch, which linked `home/u/…` - a path with **the leading
slash silently dropped**. A path containing `@` was routinely split into two wrong links:
the folder above it plus an orphan `@scope/…` fragment.

**In prose, a mid-segment `@` is still lost, and the cause is not the regex:** remark-gfm
autolinks `garland@2x.png` into `mailto:` before the linkifier runs, splitting the text
node so the path link stops at the preceding backslash. Escaping it as `\@` in
`escapeWinPaths` does not help (the escape is emitted, micromark autolinks it anyway -
measured). Code spans are unaffected. Detail in
[../tasks/at-in-filename-truncates-link/notes.md](../tasks/at-in-filename-truncates-link/notes.md).

## Non-ASCII segments, and spaces inside a path

*Previously listed here as "still open": `\w` is ASCII-only, so a path with a Cyrillic
segment did not linkify. Fixed - but the fix alone was not enough, because the paths that
prompted it have **both** properties.*

Both regexes are now built from shared parts exported by `filePath.tsx` (`PATH_CH`,
`PATH_SEG`, `PATH_FINAL`, `WIN_TAIL`) and carry the `u` flag. They were composed rather than
written inline because with Unicode classes and the branches below they exceed ~500
characters, which is not reviewable, and because `markdown.tsx` importing the same parts is
what stops the pair drifting.

**Unicode:** `[\p{L}\p{N}_]` replaces `\w`. Without it,
`d:\_BiskubFamily\Docs\Бискуб Константин Николаевич\_index.md` linked
`d:\_BiskubFamily\Docs\` - a real folder, so the click opened a listing and nothing looked
broken. Same failure shape as `.corp-account` and `@snowy_137.json`; a too-narrow class here
produces a **wrong target, not a missing link**.

**Spaces, Windows branch only.** Real paths here are full of them (`Program Files`,
`Бискуб Константин Николаевич\`, `Военный билет\`). Two guards keep prose out:

- a segment may contain internal single spaces but **may not start with one**, so
  `see d:\Docs\ and also x\y.md` stops at `d:\Docs\` instead of running through the sentence
  to the next backslash;
- a spaced segment **may not contain a dot**. The segment loop is greedy, so it otherwise ate
  prose whenever a separator turned up later: `…\tools\vault.js show companies/GMTrade/credentials/.linear`
  and `…\index.d.ts here.\` both linked whole. Every such false positive crosses a space that
  follows a dotted filename, while real spaced directories are dot-free.

**The final segment needs spaces too** (`…\Военный билет\Военный билет 12.jpg`), and that is
where prose gets swallowed, so it is anchored on an extension and crosses spaces **lazily**:
`file.md and see other.txt here` stops at `file.md`, whereas a greedy scan runs to
`other.txt`. Its `(?:-…)*` tail is required or `.corp-account` regresses to `.corp`. A
dotless alternative follows it for bare directories, which the extension anchor cannot
express.

**The extension itself stays ASCII** while the rest of the segment is Unicode. Widening it
too made Russian initials read as one: `…\Согласие на дарение Бискуб Н.М` matched with `.М`
as the extension. Initials next to a path are common; a Cyrillic-suffixed extension is not.

**Collation is pinned, not inherited.** `Intl.Collator('en', {numeric: true})` in
`fileSearch.ts`: the daemon resolves to `ru-RU`, where Cyrillic sorts *before* Latin, so a
folder listing ended `Полезные ссылки.md, CLAUDE.md` while Windows Explorer showed those two
the other way round.

**Residual, and irreducible without touching the filesystem:** a dot-free prose run followed
by a separator still matches (`D:/_Projects/_tools/telegram and check dist/`). Three distinct
false positives (~24 occurrences) survive in the audit corpus. Same wall as the `@`-mention
rules in [at-mentions.md](at-mentions.md) - only the filesystem settles it.

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

The tail is `WIN_TAIL`, written as *either* one-or-more separator-terminated segments with an
**optional** final one, *or* a final one alone:

```
(?:(?:SEG[\\/])+(?:FINAL)?|FINAL)
```

Both halves are load-bearing. Making the final segment simply optional linkifies a bare `C:\`
and the elision `C:\...`; requiring it truncates a spaced directory
(`d:\Docs\Военный билет\` came out as `d:\Docs\Военный`, because the segment loop consumed
the whole path and then had nothing left for a required final).

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

It held a second time on the Unicode/spaces widening above, and it is worth being precise
about *how* it held: a 20-case hand-written set including deliberate prose bait was **fully
green**, and the transcript audit then exposed **two false-positive mechanisms neither the
author nor the bait had thought of** (the greedy segment loop crossing a space after a dotted
filename, and Cyrillic initials parsing as a file extension). The corpus is not a formality
to satisfy after the fact - it is the only step that finds the class of error you did not
imagine. Harness:
[../tasks/at-in-filename-truncates-link/scripts/audit-transcript.js](../tasks/at-in-filename-truncates-link/scripts/audit-transcript.js),
which diffs HEAD-vs-worktree links over every transcript given to it (1,603 / 78,551 content
blocks on the last run) and marks each added link `[exists]` when it resolves on this
machine - the fastest signal for "is this a real path or swallowed prose". It handles both a
single-line regex literal and the composed `new RegExp(...)` form, taking the `PATH_*` parts
from whichever file declares them.

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
