---
name: update-extension
description: Update the installed Argus extension and browser server, bumping an unchanged version, stopping active agent turns, installing the build and verifying the restarted daemon.
---

# Update the installed Argus extension

Run this workflow when the user requests a full Argus update. An explicit invocation authorizes version changes, local installation, interruption of active Argus agent turns and daemon restart. Announce the interruption before scheduling it. Follow an explicit request to wait for agents instead when supplied. Skill creation or a question about updating does not execute the workflow. Commits and pushes require their own request.

Work from the Argus repository root and preserve existing work. Read the current project instructions, note indexes and [backend restart runbook](../../../!notes/common/backend-restart.md). The tested target-first restart helper is [restart-daemon-detached.js](../../../!notes/common/scripts/restart-daemon-detached.js). Verify this dependency exists before scheduling a live switch. Read [the successful handover evidence](../../../!notes/tasks/daemon-restart-discovery/notes.md) when diagnosing an update problem.

## Choose the target version

Inspect git status, package.json, the installed extension records and the daemon registration. Read the registration through ARGUS_DAEMON_FILE when supplied, otherwise prefer ~/.argus/daemon.json and fall back to ~/.claude/argus-daemon.json only when the current file is absent. Confirm the registered owner through GET /health and inspect its command line to locate the serving installation.

Compare numeric semantic version components, including all installed local.argus versions and the running daemon version. Ignore extension folders marked obsolete by VS Code. Use the local package version when it is already greater than both the installed and running versions. Otherwise raise the patch component above the greatest of those versions. Honor a user-specified version or increment and explain any downgrade it would cause before installing it. Change only the version field and preserve formatting. This avoids bumping again after the user already prepared a higher release version. A newer commit alone does not imply the version was bumped.

Every invocation produces a new installed version and a restarted daemon. Never conclude that no work remains because the installed extension, the running daemon and the local build already match. A matching version is the reason the patch gets raised, not a reason to stop. Do the same when the bundle bytes are identical, because the restart also replaces the daemon's environment. The only exception is resuming this same invocation after an interruption: when the target version selected by this invocation is already installed and served, verify its installed and served files and continue from the first incomplete step. Installation records, package.json and actual bundle bytes establish completion. A scheduled helper or an existing VSIX alone does not.

Before scheduling the switch, check the daemon's environment. A conversation served by the daemon inherits the daemon's environment, so run the helper with `--print-env` from that conversation. A conversation served by the daemon is any Codex turn or Claude CLI under Argus. If the stripped list contains ANTHROPIC_*, OPENAI_*, *_PROXY or CLAUDE_CODE_* variables that the provider did not add itself, the running daemon carries them and passes them to every CLI. Record their names, never their values, in the task log. A Codex turn always carries its own CODEX_*, so those variables alone are not evidence. The helper strips them from the replacement either way. The 2026-11-13 Claude 401 failures had exactly this shape: ANTHROPIC_BASE_URL and ANTHROPIC_DEFAULT_*_MODEL survived several updates because the daemon was always started with the caller's environment. Their source is `~/.codex/config.toml` `[shell_environment_policy.set]`, which injects ANTHROPIC_BASE_URL (a GLM relay), ANTHROPIC_DEFAULT_*_MODEL, API_TIMEOUT_MS, CLAUDE_CODE_MAX_OUTPUT_TOKENS and NO_PROXY into every Codex shell command. A daemon started from Codex therefore inherits them, even when the old daemon was clean. That section also sets `inherit = "core"`, so a Codex-started daemon lacks most Windows system variables. A Claude CLI started with exactly that reduced environment was verified to work, so do not treat the missing variables as a fault. If the handover ends on a daemon already at the target version that still carries them, for example after a failed attempt, run the helper once more with `--force`. It replaces a daemon already at the target version.

## Build and install before interruption

Save the current session ID and recovery URL in task notes. Read CODEX_SESSION_ID or CODEX_THREAD_ID when available and add the codex provider prefix once. In a Claude conversation read CLAUDE_CODE_SESSION_ID and use it without a prefix. Preserve the existing browser hostname, port and session query. Keep authentication material out of recovery notes and logs.

Run `yarn ext:install` and monitor it through completion. The existing installer packages the current version, runs vscode:prepublish to build the webview, compile TypeScript and build the native focus helper, then installs dist/argus-<version>.vsix through code.cmd. Resolve a build or install failure before interrupting agents.

Verify the exact installed extension directory and its package version. Compare its backend build and media/webview.js, media/webview.css and media/ws-bridge.js with the local build. Use that explicit installed daemon path for handover, since another installed version may otherwise win automatic selection. Existing test results may be cited with their actual scope. Run additional checks when a build failure or code change warrants them.

## Stop agents and switch the daemon

Inspect any pending update worker and its command line. Cancel a worker from this update when replacing it, so two helpers cannot race. Leave a worker from another task under that task's ownership and resolve its purpose before scheduling a conflicting handover.

Use the daemon WebSocket protocol to request getActiveSessions. Register the response listener before sending. A dedicated control connection can use the current workspace, client=browser and fresh=1, with the local Origin and the daemon's nonce read at runtime. Do not send a user prompt to inspect or stop a session.

For the normal full-update invocation, connect with each active session's explicit session query and send the stop control message. Close those control sockets after their response or a bounded wait. Query active sessions again and verify that the interrupted turns settle. Stop applies to active Argus provider turns, including child work owned by those runtimes. Do not replace it with a machine-wide CLI kill, which would also affect unrelated developer work. If a specific Argus-owned runtime does not settle, identify its ownership and complete the authorized forced shutdown at that boundary.

Use the target-first restart helper with --daemon-js set to the exact installed daemon. It starts the replacement with ARGUS_DAEMON_FORCE_START before stopping the old owner and verifies the new registration with up to two attempts. Resolve registration afresh during handover, since legacy registration may migrate to the current path. Carry the configured daemon port and personal runtime paths into the replacement. Remove inherited test-only ARGUS_CONFIG, ARGUS_AUTH_FILE, ARGUS_STATS_FILE and related overrides when they differ from the verified live configuration.

The daemon must never inherit the environment of the conversation running this workflow. Every CLI it spawns inherits the daemon's environment for its whole lifetime, and the workflow always runs inside some agent turn: a Codex turn served by the old daemon, or a Claude Code session with its own session, message socket and proxy variables. On 2026-11-13 a daemon started from a Codex turn passed that turn's variables to every later Claude CLI, which all failed with `401 token expired or incorrect`, while the same CLI worked from a clean shell. The helper therefore strips caller-scoped variables (CODEX_*, CLAUDECODE, CLAUDE_CODE_*, CLAUDE_AGENT_SDK*, CLAUDE_PID, ANTHROPIC_*, OPENAI_*, *_PROXY, ELECTRON_RUN_AS_NODE, VSCODE_*) and keeps only values the user persisted in the Windows user or machine environment. Always launch the daemon through this helper and never spawn daemon.js directly from a controller. Before scheduling the switch, run the helper with `--print-env` and confirm that the stripped list covers the current caller. If the conversation needs a variable that is not persisted, record it in the task notes instead of letting the daemon inherit it. After the switch, the helper log's `env:` line records what was stripped.

When running inside a conversation served by this daemon, execute the stop-and-handover sequence from a detached Node helper with ignored standard streams and windowsHide enabled. Delay the entire interruption sequence by about 15 seconds so the final response can be saved. Keep the monitor independent of the daemon process tree. Save helper scripts beside the task notes in scripts/ and their logs in .temp/. A caller outside the affected daemon can monitor the handover directly.

Do not reuse the historical update-when-idle.cjs controller unchanged. It targets a specific release. Construct the controller from the selected version and installed path, and make the default stop policy match this invocation. If the user requested waiting, use that policy instead.

## Verify the result and retain recovery

The detached controller must continue through verification even when its caller disconnects. Confirm all of the following from fresh reads.

- The discovery registration reports the target version and a live PID.
- GET /health reports that PID and the intended personal config path.
- The process command line points at the selected installed daemon.
- The helper log's `env:` line for this attempt lists the caller-scoped variables that were stripped, and a fresh Claude turn through the new daemon does not fail authentication.
- HTTP serves webview.js, webview.css and ws-bridge.js successfully, their bytes match the installed files, and their cache headers permit revalidation.
- A fresh control connection receives workspaceInfo or the requested control response.

Keep final success or failure, target version, port and recovery session URL in the task log, excluding credentials. A detached handover is pending until those checks succeed. If it fails, inspect the recorded error and current ownership, perform an in-scope recovery and verify again. Avoid repeatedly killing a daemon already registered at the target version. A single `--force` handover for the environment case in "Choose the target version" is the exception.

A freshly started daemon can be busy for several seconds. Retry the health, asset and control reads for a bounded window (about 40 seconds) before declaring failure: the 0.0.148 controller reported a timeout from one 4-second fetch although the switch had succeeded.

For a self-hosted update, the response sent before interruption must state that the switch is scheduled, give the recovery link and tell the user to reload the browser after handover. It must also say that open VS Code windows restart their extensions by themselves after a short countdown (see below). On the next interaction, check the saved verification and current health before reporting completion. A browser reload loads the new UI.

## Restart extensions in VS Code

Installing the VSIX does not replace the Argus code an open VS Code window already runs. Every open window keeps the old extension host until its extensions restart. Its Extensions view shows "Extensions require a restart to take effect" with a **Restart Extensions** button, and Argus is marked "Restart Required". Until then, that window's panels run the old extension code. Through `ensureDaemon`, the window can also respawn an old daemon if the new one dies.

Argus restarts itself (`src/frontend/updateRestart.ts`, wired in `extension.ts`). Every window running a build that has this code watches the daemon registration. When a newer daemon is serving and that version is installed next to its own folder, the window shows a 10-second cancellable countdown and runs `workbench.action.restartExtensionHost`. Because it reacts to the new daemon's registration, it also happens after the handover rather than before it. Controlled by the `argus.restartOnUpdate` setting (`auto` default, `prompt`, `off`). Guards: no restart in a development host, none when the daemon's version is not installed here, and one attempt per window per target. So this step is normally wait and verify, not click.

- Do not restart windows yourself in the normal case. Once the handover is verified, give the windows about 30 seconds: an 8-second settle delay, a poll of up to 5 seconds, then the 10-second countdown. Then verify each one.
- Verify each window: the "Restart Required" badge on Argus and the "Extensions require a restart" notice are gone. An Argus panel's Settings, Info tab shows Client and Server both at the target version with no `(stale)` marker. The "Argus Daemon" output channel logs `restarting extension host to load Argus <version>` or `update restart to <version> declined`.
- A window still on the old version means one of three things. The user cancelled the countdown (a follow-up notification then offers Restart Extensions), the setting is `off`, or the window's build predates this feature (before 0.0.151). Only then fall back to a manual restart: "Developer: Restart Extension Host" from the command palette, or the Extensions view's Restart Extensions button. VS Code has no CLI hook for it. Ask the user before doing it, or before driving the GUI on their desktop.
- A restart also restarts every other extension in that window, including Claude Code for VS Code sessions running there. The countdown exists so the user can cancel when another extension is mid-task. An Argus panel in that window reloads and rejoins its session through its `?panel=` id. Conversations served by the daemon keep running, including the one performing the update.
- `extensions.autoRestart` (hidden VS Code setting, default false) restarts updated extensions when a window loses focus. Do not turn it on as part of this workflow: it is a global user setting and fires at unpredictable moments.

Report installed and serving versions separately, active-turn interruption, which VS Code windows restarted themselves (or still need it, and why), verification status and any remaining recovery step. Aggregate file counts when files changed.
