# session-history-codex-line-count: Codex sessions have blank line counts

## Problem

The user reported that some Session History rows have no line count. The screenshot shows Claude rows with counts and Codex rows with blank count cells.

## Reproduction

Environment: `main` at `d57e328`, dirty checkout on Windows. Run `node !notes/tasks/session-history-codex-line-count/scripts/reproduce.cjs` from the repository root. The script selects a saved Codex session with a readable native transcript containing user or assistant text, requests the provider's workspace list, and compares the returned `lines` value with the transcript content. Expected: a positive line count. Actual before fix: `0`, which the UI renders as a blank cell.

## Root cause

The two list paths assigned `lines: 0` to every Codex record: `codexProvider.list()` for This workspace and the merge in `session.ts` for All workspaces. The modal deliberately renders a blank count cell when `lines <= 0`. The transcript is present, so the alternative explanation that the session lacked text is false. The original reproduction found 530 user/assistant text lines in one saved native transcript, while the list returned 0. A fixture with five text lines made the provider list return 0 before the fix and 5 after it. Appending two lines changed the result to 7, confirming that the stored transcript controls the value.

The UI is not dropping a positive value: a browser pass through both tabs rendered the fixture's 7. The defect is at the backend list mapping.

## Fix

`codexSessionLineCount()` reads a native rollout file and counts user/assistant text, reasoning summaries, and tool input/output text. Developer messages and image blocks are excluded. A cache keyed by transcript path, mtime and size avoids reparsing unchanged sessions. Both list paths use the same function. The modal needed no change. No other production session row used a zero placeholder.

## Verification

- Before: `node !notes/tasks/session-history-codex-line-count/scripts/reproduce.cjs` printed `{"nativeLines":530,"listedLines":0}` and failed.
- After: the same command printed `{"nativeLines":530,"listedLines":7283}` and passed. The larger count includes reasoning and tool text in addition to the script's user/assistant-only sample.
- The regression test was observed red at `0 !== 5`; it now passes at 5, then 7 after appending two lines. It also opens the real browser UI and verifies 7 in both Session History tabs.
- `yarn compile`, `yarn build`, `yarn test:providers` (21 passing tests), and `git diff --check` passed. A cold count across 37 saved sessions took 1067 ms; a warm pass took 64 ms.
- `yarn lint` could not start because `eslint` is unavailable. The full e2e suite stopped in global setup because an existing server on port 3001 uses the normal user config rather than the isolated e2e config. No tests from that suite ran.

## Files changed

- `src/backend/sessions.ts`, `src/backend/providers/codex.ts`, `src/backend/session.ts`
- `e2e/session-history-codex-lines.test.cjs`
- This note and its reproduction/inspection scripts

## Gotchas

The existing e2e guard prevents running against a developer server configured to read real settings. Do not stop that server merely to make the suite start.

## Decisions

Keep the count in the backend so both history tabs agree. Use the native transcript rather than a made-up estimate from provider metadata.

## Related tickets
