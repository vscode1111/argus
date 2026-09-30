# Codex shell resolution on Windows

Argus starts the Codex app-server in `src/backend/providers/rpc.ts`. The Codex process inherits the environment passed to that spawn, and its `exec_command` shell resolver searches that process's `PATH` for `bash`. An explicit Git Bash path in `exec_command.shell` selects the Bash type but does not force that executable. If `C:\Windows\System32\bash.exe` wins the search, the command enters WSL. On a machine whose only default WSL distribution is Docker Desktop, that can fail with `execvpe(/bin/bash) failed` even though standalone Git Bash works.

On Windows, `AppServerRpc` prepends the standard Git for Windows `bin` directory to the **Codex child process** `PATH` when `bash.exe` exists there. It leaves the daemon and other providers' environments alone. The path is derived from `ProgramFiles`, with `C:\Program Files` as the fallback. If Git Bash is installed elsewhere, this code leaves the inherited `PATH` unchanged; investigate the installation before changing the search rule.

Verify from a newly started Codex session with `exec_command` using `shell: "C:\\Program Files\\Git\\bin\\bash.exe"`, `login: false`, and `cmd: "echo $MSYSTEM && node -p 2+2"`. Expected output is `MINGW64` followed by `4`, with no PowerShell wrapper. The provider contract test also launches a child through `AppServerRpc` and checks that bare `bash` reports `MINGW64`.

The running daemon loads compiled code from the extension installation that launched it, which may differ from this repo's `out/`. After changing `rpc.ts`, compile and install the extension build that should serve the panel, then restart the daemon. A source-only change does not alter already-running Codex processes. See [backend-restart.md](backend-restart.md) for daemon origins and safe restart paths.

The shell resolver behavior is also tracked in [openai/codex #40328](https://github.com/openai/codex/issues/40328). The Argus environment change is scoped to its launched Codex process; a Codex process started by another application still depends on that application's `PATH`.
