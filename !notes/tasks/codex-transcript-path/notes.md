# Codex transcript path missing from Settings Info

## Problem

The user reported that Settings > Info showed a conversation ID but `-` for Transcript in a VS Code panel. The affected session was stored by the Codex provider.

## Reproduction

On `main`, with an existing native rollout file under `CODEX_HOME/sessions/2026/09/29/`, call `sessionFilePath('codex:<uuid>', workspace)` and request `getServerInfo` for that session. Expected: the rollout `.jsonl` path. Before the fix: `null`, so the Info row displayed `-`. The initial test failed with `actual: null` and an expected `rollout-...jsonl` path.

Run `node !notes/tasks/codex-transcript-path/scripts/run-reproduction.js` to compile and check both the backend response and the visible Info row with an isolated server and temporary session. The browser pass uses installed Chrome.

## Root cause

`sessionFilePath()` accepted only a bare UUID and looked in Claude's per-project directory. Codex sessions use a `codex:` prefix and date-based rollout files, so the function rejected the ID before looking at the filesystem. A real rollout file matching the reported session was present on disk. The same ID and file flipped the new assertion from `null` to the file path when the provider branch was added. The Info component already displayed any non-null `sessionPath`, which ruled out rendering as the cause.

## Fix

Resolve prefixed IDs in the native `CODEX_HOME/sessions/<year>/<month>/<day>/rollout-...-<uuid>.jsonl` tree, using the default home directory when `CODEX_HOME` is unset. Validate the UUID before scanning, and return `null` for an invalid or missing file. `getServerInfo` now uses the session a client is viewing, so a panel browsing another conversation reports that transcript rather than the entry's background session. The Claude lookup remains unchanged.

## Verification

- Before: `node --test e2e/session-transcript-path.test.cjs` failed with `actual: null` for an existing rollout file.
- After: the same test passed, including the `getServerInfo` WebSocket response. The optional browser pass opened Settings > Info and found the exact path.
- `node !notes/tasks/codex-transcript-path/scripts/run-reproduction.js`: passed.
- `npm run test:providers`: 21 passed with the new regression included.
- `yarn compile` and `yarn build`: passed. The reported session's native rollout was found in 3 ms.
- `yarn lint` could not start because `eslint` is not installed in this checkout.
- The full E2E suite was not rerun. Its previous run had one unrelated temp cleanup failure and two flaky tests.

## Files changed

- `src/backend/sessions.ts`: provider-specific transcript lookup.
- `src/backend/session.ts`: report the viewed session.
- `e2e/session-transcript-path.test.cjs`: isolated lookup, WebSocket, and optional browser checks.
- `package.json`: include the regression in `test:providers`.
- `scripts/run-reproduction.js`: repeatable compile and browser check.

## Gotchas

An Info request scans only directory names and the filenames in each date folder; it does not read transcript contents. The native file can appear after the session ID, so misses are not cached. Tests set `CODEX_HOME` to a temporary root and leave the real transcript store untouched.

## Decisions

The backend owns the path because only it knows which provider and session a client is viewing. The UI keeps its existing copyable value component.

## Related tickets

- [Panel isolation and session info](../panel-isolation-and-session-info/notes.md)
