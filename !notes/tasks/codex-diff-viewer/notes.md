# Codex file change diff viewer

## Goal

Open a visual diff from a Codex `fileChange` tool entry, including changes in old conversations.

## Existing pattern and protocol

Claude `Edit` already opens `DiffViewerModal` through `PreviewContext`. The installed Codex app-server schema defines `fileChange.changes` as an array of `{ path, kind, diff }`, with `diff` in unified format. The Codex adapter already passes that array in `call.input.changes` for live events and replay.

## Implementation

The tool label opens the first file's diff. File paths open the current text, and each file has a separate `Diff` link. `DiffViewerModal` accepts the unified patch, retains hunk headers, and computes addition/removal counts from the patch. Raw JSON output is hidden for file changes. The reducer copies the completed event's `input` for file changes, since the started event may have no patch yet. Preview ownership remains in `PreviewContext`, so the dialog survives a turn commit.

The tool row now shows classic `+N` and `-N` counters. A multi-file event shows totals in the header and separate counters beside each file. The row and modal parse the same patch through `utils/unifiedDiff.ts`, so metadata headers and hunk labels do not inflate the counts.

File paths open the current file text through the existing `PreviewContext` path request; the separate `Diff` link opens the saved patch. This applies to single-file and multi-file entries. The file preview dialog's `aria-hidden` wrapper was removed so it is exposed as a dialog to assistive technology.

## Verification

- Browser mock: a completed event with two files opened the correct diff for each; two separate hunks and +2/-2 counts were visible. The started event deliberately had an empty `changes` array. A separate single-file check opened the `Diff` link.
- Visual inspection at 1100x760 showed the existing side-by-side layout with distinct hunk separators.
- Provider contract test confirmed replay keeps the original patch.
- `yarn.cmd test:providers` (16 tests), `yarn.cmd build`, and `git diff --check` passed.
- A browser check confirmed `+3/-2` across two files, `+1/-0` on the second file, and `+2/-1` on a single-file patch containing `---`/`+++` metadata.
- A browser check clicked a real fixture path and displayed its file text, then clicked `Diff` and opened the patch; a multi-file row's separate `Diff` link also opened its patch.
- The Playwright runner did not run because its global setup rejects the active dev server using the user's configuration. The direct browser check used mock mode and did not send a real turn.
