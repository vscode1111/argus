# A hyphenated dotfile path linked to a different file

| | |
|---|---|
| Reported | 2026-09-02, screenshot of session `4dadce0f-8c87-4cc5-9a00-1575aa8f64da` (`d:\_Projects\CCS`) at `localhost:5173` |
| Produced by | Claude Code, model claude-opus-5 |
| Status | Fixed, tests green (mock), not committed |

## Symptom

"No correct path file", on `C:\Users\Admin\.claude\companies\CCS\credentials\.corp-account`
inside a code span.

## Root cause

Both path regexes end the filename with `\.\w+`, and `\w` excludes `-`, so the match
stopped at the hyphen. One cause, two different symptoms depending on where the path sits:

| Context | What the user saw |
|---|---|
| Code span (the report) | Text rendered correctly, but the link was `...\credentials\.corp` - a **different** path, which does not exist, so the click opened `Error reading file: ENOENT` |
| Prose | `WIN_PATH_RE` did not match at all, so `protectPathBackslashes` never escaped it and markdown ate the backslashes before each dot: `C:\Users\Admin.claude\companies\CCS\credentials.corp-account` |

The naming convention that produced it is routine, not exotic: the credentials files are
`.corp-account`, `.menu-cms`, `.winserver2019`. Only the last of those (no hyphen) worked.

## Fix

Both regexes, in lockstep (`webview/src/utils/filePath.tsx`, `webview/src/utils/markdown.tsx`):

- Filename suffix `\.\w+` -> `\.\w+(?:-\w+)*`, so `.corp-account` is taken whole. `\w`
  excludes Cyrillic, so a Russian suffix glued to a path ("`.md`-файл") still ends the
  match; an English one ("`readme.md`-based") would now join the link, which is the
  accepted cost of keeping the two regexes symmetric and readable.
- `[\w.\-]+` -> `[\w.\-]*` before the dot on the unix and relative branches, so a
  **leading-dot filename** matches at all. `/home/admin/.claude/credentials/.corp-account`
  and even `/etc/.gitignore` produced no link before this - a pre-existing gap the same
  case exposed (the Windows branch never had it, because its class includes separators).

## Verification

- `scripts/probe-regex.js` - runs both regexes, read straight from the source files, over
  a table of path shapes. Before: `reported BAD link=[...\.corp]`. After: `OK`, with the
  unix dotfile flipping from no match to a full match.
- `scripts/probe-dom.js` - the same path through the real renderer, printing link text,
  `title`, and the surrounding rendered text. This is what proved the prose half (eaten
  backslashes), which the regex probe alone would not have shown as a user-visible defect.
- `e2e/file-path-hyphen-dotfile.spec.ts` - code span, prose, and a control asserting a
  normal `.md` path still links whole and a second path in the same line stays separate.
- Red-verified with `scripts/mutate-regex.js old` (a whole-file revert was not an option:
  both files carry unrelated uncommitted work from [../url-linkified-as-path/](../url-linkified-as-path/notes.md)).
- Full mock suite: 257 passed, 1 failed - `model-picker.spec.ts` "a dated list id
  highlights when the active model is the dateless alias", the known config-dependent
  failure of the mock-only escape hatch, unrelated.

## Gotchas

- **The first DOM probe silently tested the wrong thing.** Its input was built with
  `String.raw`, where `` \` `` stays a literal backslash-backtick, so the "code span" case
  was escaped into prose and both cases showed the same mangled text. It happened to
  reveal the prose bug, but the reported case was never exercised until the strings were
  rebuilt by concatenation. Template escaping is part of the fixture, not decoration -
  print the input, or assert something that can only be true in the intended context.
- Reading the transcript first is what killed the initial "the regex probably rejects
  dotfiles" theory: the regex *accepts* it, then stops mid-name, which is worse, because
  the link is confidently wrong instead of absent.

## Remaining work

- Not committed.
- **Open, needs a decision:** a path whose final segment has no dot at all still matches a
  shorter prefix rather than failing. `C:\Users\Admin\.claude\companies\CCS\credentials\corp`
  links `C:\Users\Admin\.claude` - an existing *directory*, so the click opens an EISDIR
  error and the link silently points somewhere the text never named. Failing to link would
  be better than linking the wrong thing; a lookahead that refuses a match followed by more
  path characters would do it, at the cost of rejecting a legitimate path followed by a
  slash. Not touched here because it is a different class from the reported bug.
