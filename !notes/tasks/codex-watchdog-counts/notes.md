# Codex CLI watchdog and launch count

## Problem

Reported by the user on 2026-09-29. Settings showed `CLI launches 0` while the process modal showed six Codex CLI processes from this server. The two oldest had uptime of about 1h 10m; Settings > Watchdog had `Idle CLI timeout (s) 3600`. The user reports that the idle watchdog does not work for Codex.

## Reproduction

Environment: Windows, `main` at `d57e328`, installed client/server 0.0.105, daemon PID 30940, configured idle timeout 3600 seconds. The attached screenshots are the initial UI evidence. Run `node !notes/tasks/codex-watchdog-counts/scripts/probe-live.js` against the running daemon. It requests `getServerInfo` and `listCliProcesses`, then joins Codex session IDs to Argus provider metadata and prints process age and time since the last recorded turn. It prints no nonce or full session IDs.

Expected: a Codex CLI process launched by this server increases the lifetime `CLI launches` count. A finished Codex CLI whose last session activity was at least 3600 seconds ago is terminated at the next 60-second sweep. Actual from screenshot: `CLI launches 0` despite six Codex processes; two processes older than 3600 seconds were visible, but their last activity is not shown in this modal.

The live probe on 0.0.105 returned `cliLaunchCount: 0` with four owned Codex rows. The two oldest were 3753 and 3691 seconds old, but their recorded turns were only 1834 and 2655 seconds old. Both were correctly below the 3600-second idle limit; a process's launch time is not its last activity. The other two were mid-turn or younger. The current configuration really had `cliIdleTimeoutSec: 3600`.

The compiled process-list probe `node !notes/tasks/codex-watchdog-counts/scripts/check-process-scope.js` returned `osProcesses: 5, listedProcesses: 0, missingCount: 5` before the fix. It obtains the OS process list independently, then requests the compiled module's listing with an empty ownership map. After the fix, the same command returned `osProcesses: 5, listedProcesses: 5, missingCount: 0, activityMatches: true`.

## Root cause

The launch counter lived in `providers/claudeExecution.ts` and incremented only on Claude spawn. Codex's `AppServerRpc.initialize()` spawned a process without touching it. The new provider was added to `collect()`'s process sample, but `listCliProcesses()` then filtered those Codex rows back out unless this server owned their exact PID. Those two paths explain the zero launch count and the incomplete machine-wide process count.

The idle reaper itself already terminated finished Codex runtimes. A controlled provider-process test set a far-future clock, observed the decoy process die, and confirmed the session ID survived. This falsified the suspected missing Codex cleanup branch. The apparent failure in the screenshot came from comparing process uptime to the idle threshold while the process list showed `-` for Codex last activity: it looked only for a Claude transcript file, even though the channel owned the exact activity clock used by the reaper. The Codex branch also returned no `ReapedProc` record or log after disposal, so a successful reap was invisible in server housekeeping output.

Counter-hypotheses checked: the daemon was current at 0.0.105, the configured timeout was 3600 seconds, the highlighted processes were owned and finished, and their last recorded turns were younger than the timeout. The controlled decoy proved cleanup works when the idle clock is past the limit. The fix lands in the counter, process mapper, and reaper reporting paths that caused the mismatch, plus the corresponding UI labels.

## Fix

- Count both provider process launches in one server-local tally. A second turn reusing one process does not increment it. The Claude-only stop button resets only the Claude subtotal, leaving Codex launches intact.
- List every recognized CLI process from the OS sample, including Codex processes launched by another server. The per-PID termination action still validates against that sample and uses the OS image-name guard.
- Feed each owned row the channel's `lastActivityAt`, the same clock used by idle cleanup. A reaped Codex runtime now produces a log and `ReapedProc` result, matching the Claude branch.
- Rename the process modal to `CLI processes` and make its scope and the Claude-only stop button clear in Settings.

The sibling scan found that the ancestry walker recognizes Claude parents only. No Codex-under-Codex ancestry was present in the reported process tree, so it was left alone.

## Verification

- Red before fix: the provider contract asserted one new launch and received zero. Green after fix: one launch over two turns, with a Claude-only reset preserving it. Full provider contract: 17 passed.
- Red before fix: the reaper contract found no owned activity clock after successfully killing the controlled idle runtime. Green after fix: four idle-reaper tests passed, including the busy control and the Codex result record.
- Exact process-scope script: 5 OS Codex processes vs 0 listed before, 5 vs 5 after; the owned row's activity clock matched the supplied sentinel.
- `node !notes/tasks/codex-watchdog-counts/scripts/private-smoke.js` started a private backend, sent one short real Codex turn, opened its browser UI, then waited for the configured 12-second idle reap. The first server reply had `launchCount: 2` (the session and a helper launch) and one owned process with activity time. Settings > Info rendered a nonzero launch count (`5` after additional UI-initiated helper launches); the process modal rendered that PID with a real Last activity value. The daemon logged the reap at exactly 12 seconds and the process disappeared from the listing. The private backend and browser were closed, and its temporary workspace was removed.
- Mock Settings/process-modal UI: 21 passed. Process ancestry and per-PID termination guard: 12 passed. Backend compile and Vite build passed. `git diff --check` passed.
- `npm run lint` cannot run because `eslint` is not installed. The webview TypeScript check still fails on `FileViewerModal.tsx:582` (`SyntaxHighlighter` JSX type); the same error occurs in the unchanged worktree at `d57e328`.
- The full e2e suite was not run: its guard found an existing dev server on port 3001 using the user's real config rather than `e2e/argus.json`. Stopping that live server to take over the port was outside this investigation. The focused mock suite used an isolated config with `?mock=1`.
- The installed daemon remains 0.0.105, so the live `probe-live.js` result will remain old until the extension is installed and the daemon restarted. The code fix was not deployed during this task.

## Files changed

`src/backend/cliLaunchCount.ts`, `providers/claudeExecution.ts`, `providers/rpc.ts`, `channel.ts`, `processes.ts`, `session.ts`, `SettingsModal.tsx`, `CliProcessesModal.tsx`, and focused tests and task probes.

## Gotchas

Process age and last session activity differ. The idle limit is measured from the latter, and a 60-second sweep adds up to one minute of granularity. A quick look at an old PID can falsely suggest cleanup failed.

The first isolated Playwright config lacked the `mock` project name, so `waitForApp()` opened the live dev page. Its two tests that expect mock suppression failed. The config was corrected; 21 of 21 process-modal tests then passed with destructive requests suppressed. No real process was selected for termination in the failed run.

## Decisions

The process modal remains machine-wide, while the stop-all button remains Claude-only. The launch counter reports this server's process-spawn events for both providers. No commit or live deployment was requested.

## Related tickets

- [Session liveness signals](../../common/session-liveness-signals.md) separates process age, last activity, and running state.
