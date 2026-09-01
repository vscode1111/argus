# A URL gets underlined and linkified as a file path

| | |
|---|---|
| Reported | 2026-08-27, screenshot from a live session in `d:\_Projects\CCS` |
| Produced by | Claude Code, model claude-opus-5 |
| Status | Fixed, not committed |

## Symptom

In a pasted console log inside a fenced code block, part of a URL rendered as a clickable
file-path link (blue, dotted underline):

```
[WARNING] VMService https://192.168.0.12/ui/scripts/main.js .. invalid VM 1 color
[ERROR]   Failed to load resource: 500 (Internal Server Error) @ https://192.168.0.12/sdk:0
```

Only the first URL was affected. Clicking it asked the host to preview
`/192.168.0.12/ui/scripts/main.js`, which does not exist on this machine.

## Root cause

The path component of a URL is indistinguishable from a real path, and `FILE_PATH_RE` in
`webview/src/utils/filePath.tsx` takes it. Measured with
[scripts/probe-regex.js](scripts/probe-regex.js):

| Text | Claimed |
|------|---------|
| `https://192.168.0.12/ui/scripts/main.js` | `/192.168.0.12/ui/scripts/main.js` |
| `http://localhost:3001/webview.js` | `3001/webview.js` (breaks mid-host) |
| `https://192.168.0.12/sdk:0` | nothing - no dot in the last segment, so no "extension" |

That last row is why only one of the two URLs in the screenshot was highlighted, and it is
also what made the bug look random rather than systematic.

The reason it had never been noticed in normal answers: in prose remark-gfm autolinks a bare
URL into an `<a>` **before** `withLinkedPaths` runs, and that function skips link elements. So
the damage is confined to the places the autolinker does not reach - code spans, fenced
blocks, and the plain-text body of a user message (`linkifyWithMentions`, no markdown at all).

## Fix

`linkifyPaths()` matches `URL_RE` **first**, renders each hit as a `UrlLink`, and runs the
existing path scan only on the spans between URLs. The scan itself is unchanged, moved verbatim
into `pushLinkedPaths()`.

`UrlLink` opens the URL through `openExternal()` (`postMessage openUrl` + `window.open`, the
pattern the login link and the Account & Usage footer already use), with `preventDefault()` so
browser mode does not navigate the Argus page away. `MarkdownLink` routes `http(s)` through the
same helper for the prose case, which previously relied on the bare `href`.

## Superseded

**Was:** "A URL is left as plain text rather than turned into an external link: inside code that
is the correct rendering, and in prose remark-gfm already produces a real `<a>`."

**Actually:** the URL stays a link; only its *destination* was wrong. The report was
"fix that highlighting url", which I read as "stop highlighting it". The user then clarified:
*"Я имел в виду что я не против открывать эти ссылки"* - the objection was never to the link,
it was to the link opening a file preview for `/192.168.0.12/ui/scripts/main.js`.

**Why it was wrong:** the screenshot showed the symptom (blue dotted underline) and I fixed the
symptom. Nothing in the report said the highlight itself was unwanted, and "make it plain text"
silently removed a capability the user valued. A one-line bug report with a screenshot has an
ambiguous predicate, and the cheap resolution is to ask which of the two readings is meant
before writing the fix and its documentation.

**Corrected by:** the same session, after the clarification.

## Files changed

- `webview/src/utils/url.ts` - new: `URL_RE`, `trimUrl()`, `openExternal()`
- `webview/src/utils/filePath.tsx` - `UrlLink`, `pushLinkedPaths()`, rewritten `linkifyPaths()`
- `webview/src/utils/markdown.tsx` - `MarkdownLink` opens `http(s)` through `openExternal()`
- `webview/src/global.css` - `.external-url-link`
- `e2e/url-not-file-path.spec.ts` - new mock spec, 6 cases
- `!notes/common/markdown-file-paths.md` - "A URL is not a file path" section
- `!notes/common/backend-restart.md`, `!notes/common/e2e-testing.md` - see "Extracted to common/"
- `CLAUDE.md` - regex-pair bullet

## Verification

- New spec: **6/6 green** with the fix, **6/6 red** with the four changed files stashed.
- Every case pairs the URL with a real path (`src/backend/session.ts:42`) in the same message
  and asserts exactly one `a.file-path-link` and one `a.external-url-link`, so neither "nothing
  is linkified anymore" nor "everything became one kind of link" can pass.
- Two cases click: the code-block URL must call `window.open` with that exact URL **and** open
  no `[role="dialog"]` (the old bug opened an empty file preview), and the prose URL must go
  through the host rather than follow its href.
- Full mock project: **251/252**. The one failure is `model-picker.spec.ts` "a dated list id
  highlights when the active model is the dateless alias", the artifact
  [common/e2e-testing.md](../../common/e2e-testing.md) documents for the mock-only config:
  it asserts "no override yet, Default (CLI) is checked", and the real config has
  `model: "claude-opus-5"` while `e2e/argus.json` has `""`. Confirmed by diffing the two
  configs, and independently by the changed modules having no reachable path into the model
  picker (no `Markdown` / `withLinkedPaths` / linkify usage in `AccountUsageModal.tsx`,
  `InputArea.tsx` or `utils/model.ts`).
- `yarn build` clean. `tsc --noEmit -p webview/tsconfig.json` reports one **pre-existing**
  error in `FileViewerModal.tsx` (react-syntax-highlighter JSX typing), unrelated to this
  change and present on `HEAD` (verified by re-running with the fix stashed: same one error).
- The rebuilt `media/webview.js` carries the cut-out
  ([scripts/check-bundle.js](scripts/check-bundle.js)).

## Manual testing

[manual-testing.md](manual-testing.md) - a probed-live URL corpus (prose / inline code /
fenced block / user message, parens, query, trailing dot, ws://) with the expected rendering
per element and where to view it. All URLs returned 200 on 2026-08-27; the user confirmed the
set.

## Not yet visible in the running UI

The daemon serving the session that reported this runs from the **installed** extension, not
from this repo:

```
Code.exe c:\Users\Admin\.vscode\extensions\local.argus-0.0.88\out\backend\daemon.js
```

so its `MEDIA_DIR` is that folder's `media/` and a `yarn build` here does not reach it. The
fix shows up either through the Vite dev server (`http://localhost:5173/?dir=…`, which serves
the source) or after reinstalling the extension and restarting the daemon - and a plain daemon
restart from inside an Argus conversation kills the answering CLI, so use the detached
target-first swap in [common/backend-restart.md](../../common/backend-restart.md).

## Decisions

**A URL is rendered as a link everywhere, including inside code.** See `## Superseded` above
for the reversal. Code spans and fenced blocks are exactly where the user reads pasted logs and
wants to follow a host, and they are the one place remark-gfm does not autolink, so leaving them
as text is what makes the feature inconsistent.

**Opening goes through `openExternal()`, never a bare `href`.** In browser mode following an
`href` navigates the Argus page away and the conversation view is lost. The helper fires both
`postMessage openUrl` and `window.open` unconditionally, which is what the login link and the
Account & Usage footer already do; whichever is inert in the current host is harmless.

**`.external-url-link` is not styled like `.file-path-link`.** The dotted underline is the
app's signal for "this opens a preview inside Argus". A link that leaves gets the ordinary
underline-on-hover, so the two destinations are distinguishable before clicking.

**The scan was moved verbatim into `pushLinkedPaths()` rather than rewritten.** The URL cut-out
is a change to *what text the scan sees*, not to the scan, so keeping the loop byte-identical
keeps the existing path specs meaningful as controls.

**`URL_RE` covers scheme URLs only** (`scheme://…`), not bare `www.` hosts. GFM autolinks the
latter too, but `www.foo.com/bar.js` is genuinely ambiguous against a relative path, and no
reported case needed it.

## Gotchas

- **Three `node -e` one-liners in a row were mangled crossing the Git Bash boundary** -
  `SyntaxError: Invalid regular expression flags` and `Invalid Unicode escape sequence`, from a
  regex literal and from `d:\_Projects\…` in a string. The escaping cost three round trips
  before the probe went into a file, which is what `~/.claude/instructions/rules/script-location.md`
  already prescribes; that rule now names this case explicitly.
- **The first bundle check reported `false` on a bundle that did contain the fix.** esbuild
  re-escapes regex literals, so the emitted source is `[a-z0-9+.\-]*:\/\/`, not the `://` the
  editor shows. A grep for the source text is a confident false negative. Written up in
  [common/backend-restart.md](../../common/backend-restart.md).
- **The e2e run refused to start, and it was not the tests.** `global-setup.ts` found the
  user's own `yarn dev` on :3001 (adopted through `reuseExistingServer`) reading the real
  `~/.claude/argus.json`. Resolved by stopping it and restoring it afterwards - but only after
  proving the answering CLI was a child of the *daemon*, not of that dev server, so the kill
  could not abort the turn doing it. The probe is in
  [common/backend-restart.md](../../common/backend-restart.md).
- **`yarn build` succeeded and changed nothing the user could see.** The serving daemon runs
  from `local.argus-0.0.88`, so its `MEDIA_DIR` is that install's `media/`. The repo's freshly
  built bundle is never opened by it. Same doc.
- **The dev server did not have to be stopped for the first run, and the doc said so.**
  [common/e2e-testing.md](../../common/e2e-testing.md) has had a "Running mock specs without
  stopping the user's dev server" section since 2026-08-21, with a ready
  `playwright.mock-only.ts`. It was found only during the notes pass, after the server had
  already been stopped and restored. The stop was still correct for the full 250-test suite
  (`model-picker.spec.ts` reads server settings), but not for the single-file red/green run.
  The miss was procedural: `common/INDEX.md` was not scanned before taking an action that
  disrupts the user's environment. The second round of this task used the escape hatch instead
  and never touched the dev server, including for the full 252-test run.

## Extracted to common/

- [common/markdown-file-paths.md](../../common/markdown-file-paths.md) - "A URL is not a file
  path": the collision table, why prose hides it, and the three contexts a test must use.
- [common/backend-restart.md](../../common/backend-restart.md) - the install-origin trap for
  the *webview bundle*, proving a change is in the minified bundle, and the ancestor-chain
  probe for "would killing this server abort my own turn?".

## Remaining work

None in code. Not committed - waiting for an explicit ask.
