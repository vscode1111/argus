# `@` mention of a path containing spaces is silently dropped

| | |
|---|---|
| Reported | 2026-09-05, session `7d80428a-2f69-4292-b46e-b9e11f882adf` (workspace `d:\_BiskubFamily\Docs`) |
| Produced by | Claude Code, model claude-opus-5 |
| Status | Done: mention regex, path-link widening (audited), and the `@` picker. No e2e specs yet |

## Symptom as reported

`@Бискуб Константин Николаевич/Военный билет/Военный билет 12.jpg` showed only `@Бискуб`
coloured blue, in both the input overlay and the sent bubble.

## What it actually is

**Not cosmetic.** The CLI's own `@` parser stops at the first space too, so the file was
never attached to the turn - which is why the agent in the reported session fell back to
Glob/Grep/Read to find it by hand. Argus's truncated highlight was an honest mirror of
what the CLI does with the same text.

## Evidence

Three probes against a real CLI, all in `scripts/`: `probe-cli-at-expansion.js` (does it
expand at all), `probe-at-quoting.js` (which escaped form survives), `probe-at-folder.js`
(what an `@folder` pulls in). Results, the working `@"…"` form, the folder-inlining
measurement and the two probe-design traps are written up as durable knowledge in
**[../../common/at-mentions.md](../../common/at-mentions.md)** - that is the file to read,
and to update if the CLI's behaviour changes.

The one thing worth repeating here, because it nearly shipped a backwards design: **the
first expansion probe had no no-space control** and concluded "the CLI never expands `@` in
this mode". Wrong. Without a case that should work, "no expansion at all" and "expansion
broken by a space" are indistinguishable - the same shape as the slash-branch revert, where
a corpus with no control passes whatever you already believe.

## Design consequences

1. **The quoted form is lexically unambiguous**, so the extent problem dissolves for
   anything the picker inserts. `MENTION_RE` becomes `/(?<=^|\s)@(?:"[^"\n]*"|\S+)/g` in
   both copies (`webview/src/components/InputArea.tsx:31`,
   `webview/src/utils/filePath.tsx:154`) - no host round trip needed for highlighting.
2. A filesystem probe is therefore only needed to **search** for candidates in the picker,
   not to resolve where a mention ends.
3. Three regex rules were tried and killed before this (`scripts/probe-mention-re.js`);
   the decisive counter-example is `ping @snowy about the build see src/file.md`, which
   any space-crossing rule swallows whole. Do not retry them.

## Unrelated defect found alongside

`FILE_PATH_RE` / `WIN_PATH_RE` use ASCII `\w`, so a Cyrillic segment ends the match and it
falls back to the longest ASCII directory prefix. Verified in a real browser (mock mode):

| Text | Linked |
|---|---|
| `d:\_BiskubFamily\Docs\Бискуб Константин Николаевич\_index.md` | `d:\_BiskubFamily\Docs\` |
| `d:\Docs\My Folder\file.md` | `d:\Docs\My` **plus** `Folder\file.md` |

Same failure shape as [`at-in-filename-truncates-link`](../at-in-filename-truncates-link/notes.md):
the fallback target exists, so the click opens a real directory and nothing looks broken.
Independent of the `@` work, and fixed here too - both properties had to be handled together,
since every path in this workspace has Cyrillic **and** spaces. The resulting rules (Unicode
classes, spaces in a non-final segment, the lazy extension-anchored final segment, the ASCII
extension, pinned collation, and the residual false positives) are durable and live in
[../../common/markdown-file-paths.md](../../common/markdown-file-paths.md), under
"Non-ASCII segments, and spaces inside a path".

## Done

1. `MENTION_RE` accepts `@"..."`, and now lives in ONE place - `findMentions()` in
   `filePath.tsx`, used by both the input overlay and the sent bubble. Two copies of the
   pattern is why the space bug had to be found twice.
2. `FILE_PATH_RE` / `WIN_PATH_RE`: Unicode segments, spaces in Windows-branch segments,
   built from shared `PATH_CH` / `PATH_SEG` / `PATH_FINAL` / `WIN_TAIL` parts that
   `markdown.tsx` imports, so the pair cannot drift. They had grown past ~500 inline
   characters and were no longer reviewable as literals.

## Evidence for the widening

**1,603 transcripts / 78,551 content blocks** through
`../at-in-filename-truncates-link/scripts/audit-transcript.js` (extended to handle the
composed form), HEAD vs working tree. Output in `scripts/audit-out.txt`.

The first pass is the one worth keeping: **1,950 added links, and the space-bearing ones
were full of prose**. Two mechanisms, neither visible in a hand-written corpus:

- The segment loop is **greedy**, so it crossed spaces into prose whenever a separator
  turned up later in the sentence: `…\tools\vault.js show companies/GMTrade/credentials/.linear`
  and `…\index.d.ts here.\` linked whole. Fixed by requiring a spaced segment to be
  **dot-free** - the FPs all cross a space that follows a dotted filename, real spaced
  directories do not (`Program Files`, `Бискуб Константин Николаевич`, `User Data`).
- Widening the **extension** to Unicode made Russian initials read as one, so
  `…\Согласие на дарение Бискуб Н.М` matched with `.М` as the extension. Extension kept
  ASCII; the same path now resolves to the real `Согласие на дарение Бискуб Н.М. 2.jpg`.

After tightening: 184 space-bearing added links, **126 exist on this machine**; most of the
rest are real paths from other machines (`C:\Program Files\OpenSSH\sshd.exe`,
`OpenVPN Connect\profiles\…`, `Lag Logger - REPORT.lnk`). Three distinct false positives
remain (~24 occurrences), all the irreducible shape: a **dot-free prose run followed by a
separator**, e.g. `D:/_Projects/_tools/telegram and check dist/`. Not fixable lexically -
same wall as the @-mention rules.

Plus 20 cases in a real browser against the running Vite (mock mode), covering both
reported paths, the three new guards, and every earlier fix as a control (`!notes`,
`.corp-account`, `@snowy_137.json`, `scripts\`, bare `C:\`, the `C:\...` elision,
"`.md`-файл", `@types` scope, URL-not-path, `GET /api/probes/headers`).

3. `src/backend/fileSearch.ts` + the `searchFiles` -> `fileList` WS message. Files **and**
   directories, directories first then files, alphabetical.

   **Two modes, because the picker is an explorer first and a search box second.** This was
   the second thing reported ("I want similar file explorer, but you show me a lot of other
   options"): the first shape recursively dumped the whole tree, so a bare `@` buried the
   18 top-level folders under hundreds of nested ones.
   - **browse** - empty query, or one naming an existing directory (it must end in `/`,
     which is exactly what picking a folder inserts). Lists that ONE directory, immediate
     children only. The trailing slash is required on purpose: a half-typed folder name
     keeps searching rather than jumping into a directory mid-keystroke. Guarded for
     containment so a `../` in the query cannot walk out of the workspace.
   - **search** - any other query. Recursive substring match, capped at MAX_HITS, skipping
     `node_modules`/`.git`/etc. The only mode that crosses a directory boundary.

   The reply carries `mode`, `base` and `parent` so the UI can render an up row (`..`),
   which `browse` needs to be escapable.

   **`parent` is set in search mode too**, from the query's directory prefix. Reported:
   hand-editing a path down to `…/experiments/icons1` has no trailing slash, so it is a
   *search*, and search originally returned `parent: null` - the back row vanished the
   moment the path was touched by hand, leaving no way out but deleting characters. Back
   then means "drop the half-typed name and show me that folder", and it chains: from
   `…/BD/experiments/icons1` it lands on `…/BD/experiments/` (browse), whose own up row
   goes to `…/BD/`. Null only when the query has no `/` at all (a global search like
   `@паспорт` has no directory context), or when the prefix does not exist (mid-typo) or
   would escape the workspace - both verified to render no row rather than one pointing
   nowhere.

   **Collation is pinned to `en`**, not the host locale. The daemon resolves to `ru-RU`,
   where Cyrillic sorts BEFORE Latin, so the root listing ended
   `Полезные ссылки.md, CLAUDE.md` while Windows Explorer showed those two the other way
   round - a visible mismatch against the very thing the list imitates. `numeric: true`
   also keeps `2` before `10`.
   `mentionFor()` decides the quoting. Verified against the real `d:\_BiskubFamily\Docs`
   (`scripts/probe-search.ts`): ordering matches the target screenshot row for row, and a
   query keeps a matched folder's children visible. Note the root walk hits the 400 cap
   there and reports `truncated`, so the UI needs a "keep typing" hint.

4. The picker **UI** in `InputArea.tsx`. Trigger, debounced search, keyboard nav, and
   insertion, reusing the slash menu's markup and styles.

   Three things worth not rediscovering:
   - **The query may contain spaces.** Cutting it at the first space (as the slash trigger
     does) would make the picker useless for the very names it exists for. It closes
     instead when a query stops matching anything, which is what gets it out of the way
     when the `@` was ordinary prose.
   - **Rows commit on `onMouseDown`, not `onClick`.** A click blurs the textarea first, and
     `getAtContext()` is caret-relative, so by the time the handler ran there was nothing
     to replace.
   - **The dropdown height is measured, not a `vh` fraction.** `.slashMenu` caps at 260px,
     which left a 20-row listing scrolling inside a letterbox with most of the window empty
     above it. The menu is `position: absolute; bottom: 100%` inside `.inputArea`, so it
     grows upward into space CSS cannot see; `inputAreaRef.getBoundingClientRect().top` IS
     that space. A `vh` fraction was rejected because the input area is drag-resizable and
     also grows with pasted images and with the textarea itself, so any fixed fraction
     spills off the top of the window once the input gets tall. Applied inline to the `@`
     menu only, in a `useLayoutEffect` that re-measures on resize and on every input that
     can move that edge, and returns the previous value when unchanged so it cannot loop.
     `max-height` only caps, so a two-row result still renders two rows.
   - **The parent column needs two elements.** `direction: rtl` gives left-truncation (the
     tail names the folder, the root prefix repeats on every row), but an RTL paragraph
     reorders the neutral characters at each end: `.vscode/` rendered as `/vscode.`.
     Putting `<bdi>` on the same element does **not** fix it - the class forces the isolate
     itself to RTL. The outer span keeps the truncation, an inner `<bdi>` restores LTR.

   Verified in a real browser against `d:\_BiskubFamily\Docs` with the live backend: `@`
   lists the tree in the target order with folder counts, `@Бискуб Артем` (a query **with a
   space**) narrows to 31 hits, and committing one inserts
   `@"Бискуб - Анталья/Бискуб Артем Константинович - Заявление о рождении.docx"` - quoted,
   which is the form the CLI actually expands.

5. **Picking a folder drills into it** instead of closing the menu (reported: "in that case
   folder modal doesn't appear" - once a folder was chosen there was no way to reach
   anything inside it).

   The mention is still written out in full, `@"…/Архив/"` closing quote and all, so the
   text is a valid sendable mention at every step - a folder is a legitimate target, it
   inlines everything underneath. The menu then stays open with that folder as the query.
   Two consequences worth keeping:
   - `getAtContext()` **strips quotes** when building the query. A committed mention reads
     `@"Бискуб …/Архив/"`, and searching for that verbatim matches nothing; stripping is
     what lets the just-inserted folder act as the next query. The backend's substring test
     is against the un-slashed `childRel`, so a folder query lists its children and not the
     folder itself - exactly right for drilling.
   - Committing a FILE sets a `justCommitted` ref, consumed once by `updateAtState`. A
     complete mention under the caret matches itself, and `setSelectionRange` fires a
     `select` event, so without it the menu reopened on the thing that had just been chosen.

   To keep the folder rather than drill, just carry on typing - verified:
   `@"…/Архив/" что тут лежит?` keeps the mention as a single highlighted span with the menu
   closed. Escape closes, and prose after a bare `@` never holds it open.

## Not done
- e2e specs for all of the above. The mock suite has not been run: the global-setup guard
  refuses while a `yarn dev` started without `ARGUS_CONFIG` holds :3001, so running it
  costs the user their dev server.

## Files

- `webview/src/components/InputArea.tsx` - highlight overlay, picker host
- `webview/src/utils/filePath.tsx` - `findMentions`, `MENTION_RE`, `FILE_PATH_RE`, path parts
- `webview/src/utils/markdown.tsx` - `WIN_PATH_RE`, built from the shared parts
