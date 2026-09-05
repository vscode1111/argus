# `@` in a filename truncates the link to the folder above it

| | |
|---|---|
| Reported | 2026-09-03, screenshot of session `6cbf4cbd-afda-4e43-8d32-44af9de707d1` (workspace `d:\_Projects\GMTrade`) |
| Produced by | Claude Code, model claude-opus-5 |
| Status | Fixed; one adjacent defect found and left labelled open (see below) |

## Symptom

`D:\_Projects\_tools\telegram\out\@snowy_137.json` rendered with only
`D:\_Projects\_tools\telegram\out\` underlined. Not "no link" - **a link to something
else**, and that something exists, so nothing about the click looked broken: it opened a
directory listing of the folder instead of the file the sentence was about.

## Cause

Neither regex accepted `@` in a filename. `FILE_PATH_RE`'s Windows branch is
`…(?:[\w.\-!]+[\\\/])*[\w.\-!]*[\w\-!][\\\/]?`, and since a directory is a valid target,
failing on the final segment does not fail the match - it **falls back to the longest
directory prefix**. Same shape as the `.corp-account` bug: the class was too narrow, and
the failure surfaced as a wrong target rather than a missing one.

Three variants of the same hole, all found in real transcripts:

| Text | Linked before | Linked now |
|---|---|---|
| `…\telegram\out\@snowy_137.json` | `…\telegram\out\` (a folder) | the file |
| `…\node_modules\@v3group\…\index.d.ts` | `…\node_modules\` **plus** an orphan `@v3group/…/index.d.ts` | one link, the file |
| `/home/u/node_modules/@types/node/index.d.ts` | `home/u/…` - the relative branch picked it up and the **leading slash was dropped** | the file |

## Fix

`@` added to the character classes of `FILE_PATH_RE` (`webview/src/utils/filePath.tsx`)
and `WIN_PATH_RE` (`webview/src/utils/markdown.tsx`), asymmetrically on purpose:

- **Windows branch: anywhere in the run.** The drive letter is the evidence that this is a
  filesystem path, and an email address cannot appear there. Needed for the mid-segment
  case, which is not exotic - `garland@2x.png`, `main-instruction-select-project@2x.webp`
  (retina assets, 12 in the CCS transcripts) and
  `ms-playwright/b/browser@6e474dac0d92299fe328d6fb31ab7b56`.
- **Unix and relative branches: in a directory segment, but only at the *start* of the
  final one (`@?`).** That is where a scoped package name puts it (`@types/index.d.ts`)
  while an address puts it in the middle, so `docs/john@corp.com` stays prose.

## Evidence

Three passes, because a hand-written corpus is not sufficient for a widening (the
[slash-branch revert](../../common/markdown-file-paths.md) is the precedent):

1. `scripts/probe-at-paths.js` - 18 cases through both regexes in sequence, pulled out of
   the source at runtime. Red before (7 failing), green after. Includes the handle/email
   bait and re-asserts the `!notes` and `.corp-account` cases.
2. `scripts/audit-transcript.js` - renders **1,471 real transcripts / 60,653 content
   blocks** (CCS, GMTrade, argus, people-research, b2b-admin - a corpus full of Telegram
   handles and work email) through the HEAD regexes and the working-tree ones, and diffs
   the links. **94 added, all of them filesystem paths, most marked `[exists]` on this
   machine; 0 handles, 0 addresses.** All 77 removed are the wrong halves of the splits
   above. Output kept in `scripts/audit-out.txt`.
3. A real browser against the running Vite dev server (mock mode): 7 cases including the
   three controls. This is the pass that found the defect below - the first two simulate
   markdown with `t.replace(/\\(.)/g,'$1')`, which is not the parser.

`e2e/file-path-at-sign.spec.ts` (mock) locks in all of it, with the handle+email line as
the control that a blanket "accept @ everywhere" would fail.

## Left open: remark-gfm eats a mid-segment `@` in PROSE

`…\newYear\garland@2x.png` written as prose renders as a folder link **plus a
`mailto:garland@2x.png` link**: remark-gfm's email autolink claims it before the linkifier
runs, splitting the text node, and `withLinkedPaths` skips `<a>` elements by design. The
regex is right; the parser got there first. In a **code span** - where these paths almost
always appear, and where the reported one was - no parser runs and it links whole.

**Do not retry the obvious fix.** Escaping `@` as `\@` inside `escapeWinPaths` was tried:
the escape is genuinely emitted (`garland\@2x.png`, verified with
`scripts/probe-escape.js`) and micromark autolinks it anyway. Reverted rather than left in
as dead code. A real fix would have to either drop the GFM autolink-literal extension
(which would also stop legitimate email/URL autolinking) or re-join the `text` + `mailto`
anchor pair inside `withLinkedPaths`. Neither is worth it for a case that only bites in
prose.

Note the reported path is **not** affected: the character before its `@` is a separator,
so the email autolink has no local part and never forms.

## Files

- `webview/src/utils/filePath.tsx` - `FILE_PATH_RE`
- `webview/src/utils/markdown.tsx` - `WIN_PATH_RE`
- `e2e/file-path-at-sign.spec.ts` - new mock spec
- `!notes/common/markdown-file-paths.md` - the durable rule
