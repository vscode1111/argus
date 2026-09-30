# Direct Git Bash selection for Codex commands

## Problem

`exec_command` launched WSL when asked to use Git Bash, ending with `execvpe(/bin/bash) failed: No such file or directory`. Git Bash worked in VS Code's terminal and in its standalone `MINGW64` window. Calling Git Bash from PowerShell worked but introduced an unwanted extra shell.

## Reproduction

From an Argus Codex session on Windows, call `exec_command` with `shell: "C:\\Program Files\\Git\\bin\\bash.exe"`, `login: false`, and `cmd: "echo $MSYSTEM && node -p 2+2"`. Before the fix, this returned the WSL `/bin/bash` error. A provider child launched from the unmodified `AppServerRpc` inherited a `PATH` whose first entry was not Git Bash; the new provider contract test failed on that assertion.

## Root cause

The Codex CLI processes were children of the Argus VS Code daemon. `AppServerRpc` spawned them without an environment override. Codex treated the supplied shell path as a Bash type hint, then searched its inherited `PATH`; Windows' WSL launcher appeared before Git Bash. Installing a WSL distribution would have changed the runtime rather than selecting the user's existing `MINGW64` shell. See [Codex shell resolution on Windows](../../common/codex-shell-resolution.md) for the reusable mechanism.

## Fix

On Windows, `src/backend/providers/rpc.ts` now prepends the standard Git Bash directory to the environment of the Codex child when that executable exists. The installed extension's compiled `rpc.js` received the same local change, and the Argus daemon was restarted to load it. The global shell rule was updated to select Git Bash directly.

## Verification

- The provider contract test failed before the source change, then passed after it. Its child process resolved bare `bash` to `MINGW64`.
- `npm run compile` succeeded and `npm run test:providers` passed all 22 tests.
- The installed extension's patched provider reported `MINGW64` in a separate smoke check.
- After daemon restart, the registration and health endpoint both reported the new daemon PID. A direct `exec_command` call with Git Bash selected printed `MINGW64` and `4` without PowerShell.

## Gotchas

- The initial WSL error suggested a broken Bash installation, but the standalone Git Bash terminal proved otherwise. Inspect the parent process and the child `PATH` before changing WSL.
- A successful `PowerShell -> Git Bash` command proves Git Bash works, not that `exec_command.shell` selected it directly.
- The installed extension has its own compiled backend. Building the repo alone cannot change the running daemon; the local installed-file patch will be replaced by a future extension installation, so the source change must be included in that build.
