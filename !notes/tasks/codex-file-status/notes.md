# Codex file status in change rows

## Problem

The reported Argus conversation showed `fileChange 2 files +0 -0` with two file rows that also showed `+0 -0` and `Diff`. The requested UI uses green paths for added files and red, struck-through paths for deleted files. Reported from session `01a0ec0b-975d-7041-a849-5d49d61ba4a0` on 2026-09-29.

## Reproduction

On `main` at `d57e328`, build the webview with `npm.cmd run build`, then run `node !notes/tasks/codex-file-status/scripts/run-reproduction.js`. The script starts a private compiled server on port 5182 with the e2e config and runs Playwright against its real browser UI. The test injects a completed `fileChange` with added and deleted files whose patch is empty, plus an edited file with a one-line replacement.

Expected: added/deleted rows have no counters or `Diff`; paths use the requested colors and deletion line-through. Actual before the fix: each empty row had two counters and a `Diff` link. Playwright failed with `Expected: 0, Received: 2` for the added row's stats. A separate metadata-only patch test failed in the diff dialog with the same `Expected: 0, Received: 2` count. These are sanitized protocol fixtures, not a dump of the user's session.

## Root cause

`ToolCall` parsed the unified patch correctly, but rendered both numeric counters and the Diff control unconditionally for every change. It also ignored the `kind.type` field that the provider already passes through. `DiffViewerModal` repeated the unconditional counter rendering. A control with an update patch displayed real `+1 -1`, which rules out a broken parser; an add/delete with an empty patch displayed `+0 -0`, which rules out a missing backend event. The screenshot's exact raw app-server event was not available, so the reproduction uses the established `fileChange.changes` contract and the visible zero-count shape.

## Fix

Render only nonzero counters. Render `Diff` only when the saved patch contains text, including metadata-only patches. The tool label opens the first available patch in a multi-file change. Added paths use the existing diff green token. Deleted paths use diff red with line-through and are no longer links to a file that has been removed. The same counter rule applies inside the diff dialog.

## Verification

- Before: browser reproduction failed with two zero counters on an empty added-file row.
- After: the same script passed all six browser tests, including the existing multi-file and single-file patch controls.
- The metadata-only diff-dialog test also failed before its UI change and passed after.
- `npm.cmd run build`, `npm.cmd run compile`, and `git diff --check` passed.
- `tsc -p webview/tsconfig.json --noEmit` still reports the pre-existing `SyntaxHighlighter` JSX type error at `FileViewerModal.tsx:582`; there were no new errors.
- `npm.cmd run lint` cannot start because `eslint` is not installed in this checkout.

## Files changed

- `webview/src/components/ToolCall.tsx`, `ToolCall.module.css`, `DiffViewerModal.tsx`
- `e2e/codex-file-status.spec.ts`, `e2e/codex-file-diff.spec.ts`
- `scripts/` contains the isolated browser reproduction runner.

## Gotchas

The installed VS Code extension has its own bundled webview; rebuilding this checkout does not update that installation.

A later screenshot showed a newly created, still-untracked `notes.md` with `-8` in a subsequent `fileChange` group. Counters describe that group's patch, not the file's creation or Git status. The exact eight removed lines were not recovered; the event semantics are documented in [file-change event display](../../common/file-change-events.md).

## Decisions

An empty patch has no useful Diff action. A metadata-only patch can still carry file operation information, so its Diff action stays available even with zero changed lines.

## Related tickets

- [Codex diff viewer](../codex-diff-viewer/notes.md)
- [File-change event display](../../common/file-change-events.md) explains counter and status semantics.
