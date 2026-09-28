# Integration verification, 2026-09-28

## Latest confirmed full suite

After the logged-out insights, network-setting, and dialog drag-handle regressions were fixed, the exact `yarn test:e2e` command completed with:

```text
18 skipped
535 passed (8.4m)
Done in 506.17s.
Exit code: 0
```

The 553-case run had no failures, flaky cases, or dependent cases left unexecuted. The affected dialog scenario also passed 30/30 with retries disabled and the complete dialog-state file passed 6/6. The user's independent full run confirmed the same 535 passed / 18 skipped result in 494.41 seconds. `yarn build` and `yarn compile` pass.

## Earlier exact-command run

`yarn test:e2e` was executed in Git Bash with PATH rebuilt from the Windows user and machine values, without the desktop-added executable directory. No project, worker, retry or reporter overrides were passed.

```text
18 skipped
534 passed (8.8m)
Done in 527.55s.
Exit code: 0
```

All 552 cases belong to this single run, with no failed, flaky or dependent-unexecuted cases. The 18 skips remain the documented Claude-specific cases. This supersedes the earlier combined-project result below.

The first exact-command run returned code 1 with 533 passed / 18 skipped / 1 failed: the streaming response was still emitting deltas after its 20-second assertion deadline. The wait is now 45 seconds within the existing test budget, with all streaming assertions preserved.

A separate ordinary-PATH startup probe reproduced ENOENT before the Windows executable resolver fix and successfully initialized the native app-server afterward. The resolver respects the explicit override and PATH before using the installed desktop executable. All 13 isolated contract tests and backend compilation pass.

Full integration inventory: 159 tests in 52 files. Shared cases use the real Codex runtime. Automatic retries were disabled in every run.

| Run | Passed | Failed | Skipped / not run |
| --- | ---: | ---: | --- |
| Initial full run | 125 | 9 | 23, including dependent cases |
| Targeted fixes, including two new native cases | 34 | 1 | 0 |
| Second full run | 134 | 2 | 18 explicit Claude skips, 5 dependent cases |
| Final recheck of both affected files | 15 | 0 | 0 |

Final status across the full run and final recheck: **141 passed, 18 explicit Claude skips, 0 unresolved failures, 0 unexecuted dependent cases**. This is a combined result, not a claim that the second full run was green. Of the passing cases, 90 are shared, 2 native Codex and 49 use local Claude behavior (including the switch from Claude to Codex).

## Fixes validated

- Retry the native interrupt registration race within the existing stop deadline. The isolated regression failed before the fix and passed afterward.
- Preserve native usage counters in session state for live reattachment; reset them for a new turn. Its isolated regression also failed before the fix. The real browse/return scenario passed.
- Separate history title text from provider badges and remove markup accidentally included in the title tooltip.
- Emit diagnostic event names for Codex without logging event payloads. Real log-autoscroll coverage passes.
- Adapt session-id assertions, session-local model selection, tool-boundary usage timing and stop/send checks to provider-neutral behavior.
- Restore leaked test environment variables; retry only transient Windows config writes; use isolated workspaces and allow real response latency in the connection test.

## Other checks

- 11/11 isolated app-server contract tests pass.
- Backend TypeScript compile and frontend production build pass.
- Complete mock project: 393/393 passed, no skips, no retries (57.9 seconds). See [mock report](mock-final.json).
- Existing frontend standalone typecheck and missing ESLint limitations are recorded in [notes](notes.md).

## Explicit skips

15 need Claude network access, currently unavailable. Three pre-existing AskUserQuestion tests remain skipped because Claude print mode does not support their premise. Enable network-dependent tests with `ARGUS_TEST_CLAUDE=1`; this does not enable the three pre-existing skips.

- `account-usage-integration.spec.ts`: fetches real account info from `claude auth status`
- `account-usage-integration.spec.ts`: renders the Usage section up front (live API, or graceful fallback)
- `account-usage-integration.spec.ts`: rendered usage values match the live /oauth/usage API
- `ask-dialog-integration.spec.ts`: AskUserQuestion dialog: 3 tabs, Other option, submit enables after all answered
- `ask-dialog-selection-integration.spec.ts`: selecting non-first option: Claude acknowledges the correct choice
- `ask-dialog-selection-integration.spec.ts`: selecting last option: Claude acknowledges correct choice
- `context-window-integration.spec.ts`: the pill reports a percentage of the seeded model window, not a fixed 200k
- `file-preview-copy-integration.spec.ts`: copy path button copies file path from Read tool preview
- `session-deep-link-integration.spec.ts`: deep link attaches to the live turn without any click; stop from the linked page ends it for both
- `session-deep-link-integration.spec.ts`: a new chat puts its assigned session id into the page URL
- `session-history-line-count-integration.spec.ts`: the live session row shows a transcript line count that grows with the conversation
- `session-history-line-count-integration.spec.ts`: all-workspaces rows render a numeric line-count column from real transcripts
- `session-info-integration.spec.ts`: Info tab shows the live session id and its transcript path
- `stop-no-placeholder-integration.spec.ts`: a stopped turn leaves no "No response requested." placeholder in the transcript
- `tool-image-preview-integration.spec.ts`: an image read by the agent previews after its file is deleted, without shipping the bytes
- `usage-indicator-integration.spec.ts`: a modal fetch becomes the snapshot every other client reads
- `usage-indicator-integration.spec.ts`: the header indicator fills in from the server, with no injected data
- `usage-indicator-integration.spec.ts`: the daemon polls on its own and serves every client from that one fetch

## Evidence and reproduction

- [Full run JSON](integration-final.json)
- [Final recheck JSON](integration-recheck.json)
- Full run: `npm run test:e2e:integration -- --retries=0`
- Final recheck: `npm run test:e2e:integration -- --retries=0 clients-integration shared-channel-integration`
- Protocol checks: `npm run test:providers`

## Complete mock suite follow-up

The first full mock run was 347 passed / 46 failed. The failures were confined to six files: provider/account replies from the real backend replaced injected data, and two file-preview checks assumed an obsolete first source line. The dev mock bridge now filters server provider metadata and suppresses account queries; mock cases explicitly supply account data. File-preview expectations read the current source line from disk.

All 78 cases in the affected files passed on recheck, then the entire mock project passed all 393 cases in one run, without retries or skips. Playwright discovery now includes only `.spec.ts` files for this project so separate `node:test` contracts are not executed during discovery.

At that stage, the integration verification and complete mock run accounted for **534 passed, 18 explicit Claude skips, 552 total Playwright cases**. The later full-suite result above supersedes these totals. The node protocol tests are separate.

After rebuilding, the real provider switch/reply/reload integration case passed again (21.3 seconds), confirming that the mock-only bridge filter does not suppress production messages. [Report](bridge-integration-recheck.json).
