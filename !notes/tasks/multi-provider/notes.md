# Multiple conversation providers

## Problem
The account/model UI and backend execution were bound to Claude Code. Add Codex while keeping existing conversations usable and allowing future adapters.

## Decisions
- AgentProvider owns discovery, validation, account, skills and history. AgentSession owns a live turn, interrupt, interaction responses and disposal. Registry lookup is the only provider dispatch point.
- Claude execution moved to providers/claudeExecution.ts with its existing protocol and stop handling. Codex uses app-server JSONL stdio, one child per conversation. This is an agent runtime integration, not a raw text completion API.
- The provider, model, effort and thinking selection belongs to SessionState. Switching providers creates a fresh entry. Changing defaults is a separate explicit action. Metadata beside argus.json persists bindings; native transcripts/authentication stay with their owning CLI.
- Native Codex ids are namespaced with codex:. Only records created through Argus appear in its Codex history. Workspace ownership is checked before resume/archive.
- Browser state mutations are ordered per connection. Network metadata queries remain independent. Late turn events are ignored. Interrupt waits for completion before another send; an unacknowledged interrupt terminates only the owned process.
- Known approvals/questions have exactly one RPC response. Unknown requests are rejected. Pending interactions survive client reconnection. Watchdog pauses for user input and never replays a Codex operation automatically.
- Model capabilities control effort/input options. Slash skills resolve through native skills/list and send a skill input with the discovered path.

## Verification
- Real installed Codex app-server 0.155.0-alpha.16: initialize, model/account discovery, turn, interrupted turn, replay and resume in a new process.
- Browser integration: switch to Codex, preserve draft, another tab remains on Claude, receive actual response, reload conversation with its original provider.
- Eleven transport contract tests cover duplicate suppression, late deltas, stop/send ordering, startup interrupt registration races, usage state for reattachment, questions, unknown approvals, attachments, skills, selection isolation and ordered replay.
- Full integration inventory and final recheck: 141 passed, 18 explicit Claude skips, no unresolved failures or unexecuted dependent cases. The second full run was 134 passed / 2 failed / 23 skipped or dependent; both affected files then passed all 15 cases with retries disabled. See [verification](verification.md) for exact runs and skip reasons. All 11 protocol tests pass; the complete mock project subsequently passed all 393 cases with no skips or retries. Settings launch-argument tests stop after observing the real spawn command; they do not wait for an unrelated network response.
- Backend compile and frontend production build pass. Frontend standalone typecheck has the same SyntaxHighlighter/refs diagnostic in unchanged HEAD; verified with a compiler host reading tracked source from HEAD. The lint command cannot run because ESLint is not installed in this checkout.

## Gotchas
- Codex is a bidirectional protocol: server requests require replies. Ignoring them leaves a conversation waiting forever.
- Completed agentMessage content repeats streamed deltas; rendering both duplicates the answer.
- Windows keeps a provider workspace directory locked while its process lives. Tests must dispose the session before deleting that directory.
- Existing settings specs assumed global mutations and were updated to explicitly save defaults. Large project instructions made real test turns exceed a minute; use a fresh isolated workspace for settings tests.
- A successful native turn/start response can precede interrupt registration. Retry only the specific no-active-turn interrupt error within the existing five-second termination deadline. Never retry the user's turn.
- Native usage notifications must also update SessionState's counters because live reattachment reads those fields. Codex can report usage only after a model call ends; the shared browse/return integration scenario uses a tool boundary before a long response to obtain measured usage while the turn remains active.
- Keep provider badges outside the session title's text node. Otherwise exact-title lookup and accessible text include the badge; native event names are logged without event payloads so diagnostic scrolling works with either provider.
- Integration tests import provider-fixtures. Shared cases default to Codex, @claude selects local Claude behavior, and @claude-live additionally requires ARGUS_TEST_CLAUDE=1. Never gate a shared failure merely because the suite previously used Claude.
- Restore environment overrides in remote-auth tests. A leaked ARGUS_CONFIG pointed subsequent cases at a deleted temporary config. Shared config writes use a bounded Windows file-lock retry instead of retrying entire tests.

## Limits
One existing local CLI login per provider. Codex login is initiated with codex login on the server, not an embedded OAuth dialog. Context transfer and inline-completion migration are outside this increment. Codex supports text/images; PDF, Claude attribution/background-task conventions and transcript tool-image preview remain provider-specific. File-change tools retain native change data in the generic tool result.

## Mock isolation follow-up
The full 393-case mock project initially exposed 46 failures across account/usage/model/slash fixtures and file previews. The dev bridge now filters live provider metadata in mock mode and suppresses getAccountUsage; fixtures explicitly settle the account phase. Real provider switching remains verified by a successful Codex reply/reload integration recheck after the bridge change. Playwright excludes node:test contracts from mock discovery.

## Ordinary terminal reproduction
The exact combined `yarn test:e2e` command first produced 533 passed / 18 skipped / 1 failed (8.5 minutes). The streaming test was still receiving native text deltas when its 20-second completion assertion expired, twice. Its completion wait is now 45 seconds inside the existing 60-second test budget; chunk-count and chunk-size assertions are unchanged.

The desktop agent process had a bundled executable directory on PATH that neither the Windows user nor machine PATH contained. Spawning the default executable with the ordinary PATH reproduced ENOENT. The Windows resolver now respects ARGUS_CODEX_BIN, then native PATH executables, then the newest installed desktop executable. Native app-server initialization with ordinary PATH passed afterward. Two resolver tests bring the separate contract suite to 13 passing cases.

Final exact-command verification: `yarn test:e2e` in Git Bash with ordinary Windows user/machine PATH returned exit code 0: 534 passed / 18 skipped, 527.55 seconds. No failed, flaky or unexecuted dependent cases. This is one full run, superseding the earlier totals combined from separate projects.

## Logged-out usage insights regression

A later full run exposed two environment-sensitive failures when Claude account discovery returned `loggedIn: false`. The Account & Usage component placed local transcript insights inside the logged-in account branch, so the Day/Week report disappeared even though it does not require network access or an authenticated account. The local insights block is now Claude-specific but independent of account login. The mock suite explicitly selects Claude for these provider-specific cases and covers the logged-out state.

The same run exposed a network test race. A late `getSettings` reply could make the React checkbox display the requested value before the UI had sent the corresponding `updateSettings`, so a state-based helper could skip the click while the backend retained the previous value. The network suite no longer imports provider fixtures or writes its baseline directly to the shared config file. Each case establishes its baseline through the backend, dispatches the native checkbox event with the intended value, and polls the real backend setting before probing origins. Both previously unstable cases passed 20/20 separately with retries disabled, then the complete network file passed 3/3.

Final exact-command verification after both fixes: `yarn test:e2e` returned exit code 0 with 535 passed and 18 explicit `@claude-live` skips in 544.84 seconds. There were no failures or flaky cases. `yarn build` also passed before the test-only network stabilization.

## Dialog drag handle regression

A subsequent full run caught `no handle box` in the Account & Usage geometry test while the failure screenshot showed the dialog itself was visible. The helper located the drag handle by a substring of a generated CSS-module class and called `boundingBox()` without waiting for that descendant through a possible modal remount. Shared modals and Settings now expose the same stable `data-dialog-drag-handle` marker; the helper waits for that exact element to be visible before measuring it. The affected scenario passed 30/30 with retries disabled, the full dialog-state file passed 6/6, and the exact `yarn test:e2e` command then passed 535 tests with 18 explicit `@claude-live` skips in 506.17 seconds. The user's independent full run confirmed the same 535 passed / 18 skipped result in 494.41 seconds. `yarn build` and `yarn compile` also passed.

## Provider-specific permission control

The input bar keeps Claude's Edit/Plan toggle. Codex shows Ask, Plan, and Full, with descriptions in its dropdown. Switching providers resets the choice to Ask/Edit, so a prior Full choice is never carried to a different provider. Codex sends the selected approval and sandbox settings on both thread creation/resumption and each turn. Full access uses approvalPolicy never, sandbox danger-full-access, and sandboxPolicy type dangerFullAccess; the other modes retain their existing restrictions. The contract fixture checks all three wire modes. Build, compile, all 14 provider contract cases with `node --test --test-force-exit`, and a direct browser mock check passed. The contract runner needs `--test-force-exit` because an existing open handle otherwise keeps it alive after the tests finish.
