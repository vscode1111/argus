# Argus - VS Code Extension

AI coding assistant powered by Codex, built as a VS Code extension.

## Project Structure

- `src/backend/` owns the server, CLI process and session handling.
- `src/` also contains the VS Code extension integration.
- `webview/` owns the React client and UI state.
- Read the [detailed project map](!notes/common/project-map.md) when locating a component; verify its path in the current tree.

## Key Conventions

- Tool approval: destructive tools (write_file, bash) require user confirmation via `showWarningMessage`.
- Use Node.js or TypeScript for tooling, not Python.
- Webview UI uses React 18, TypeScript, Vite, and CSS Modules.
- Browser hosts supply their own VS Code theme variables; keep `webview/index.html` and `media/browser.html` in sync when UI CSS adopts another token. See [browser host theme parity](!notes/common/browser-host-theme.md).
- Session and channel state is shared across the extension and browser clients; check the backend details before changing lifecycle or protocol behavior.
- Read the relevant detailed notes before changing these areas: [UI and test conventions](!notes/common/ui-conventions-detail.md), [backend and session conventions](!notes/common/backend-conventions-detail.md).

## Skills

| Skill | Path | When to use |
|-------|------|-------------|
| frontend | `.claude/skills/frontend/SKILL.md` | Building or reviewing webview UI, React components, CSS styling |

## Slash Commands

| Command | Description |
|---------|-------------|
| `/bump` | Bump package.json version (patch/minor/major) |
| `/dev` | Control dev environment (start/stop/restart/status) |
| `/e2e` | Run Playwright e2e tests (all/mock/integration/specific file) |

## Development

```sh
yarn dev          # starts Vite frontend (port 5173) + WebSocket server (port 3001) in parallel
yarn dev:frontend # Vite dev server only (no backend)
yarn dev:server   # WebSocket server only (tsx server/index.ts)
yarn daemon       # run the always-on daemon (tsx src/backend/daemon.ts); fixed port 3017, 10-min idle-exit
yarn daemon:stop  # stop the running daemon (node scripts/daemon-stop.js; idempotent)
yarn build        # bundle React webview to media/webview.js + media/webview.css
yarn watch        # watch + rebuild webview on save (for VS Code Extension Host testing)
yarn compile      # compile extension TypeScript
yarn watch:tsc    # watch mode for extension TypeScript
yarn test:e2e     # run Playwright e2e tests (starts dev server automatically)
yarn test:e2e:integration # run only integration tests (skips mock dependency)
yarn test:e2e:headed # run e2e tests with visible browser
yarn test:e2e:ui  # open Playwright UI mode
yarn ctx:install  # add "Open Argus" to Windows Explorer context menu (requires elevated shell)
yarn ctx:uninstall # remove context menu entry
# Primary UI testing: use `yarn dev` + browser refresh - do not suggest reloading VS Code extension
# Press F5 in VS Code to launch Extension Development Host (for extension-side code only)
```

## Commands

| Command | Keybinding | Description |
|---------|-----------|-------------|
| argus.openChat | Ctrl+Shift+A | Open chat panel |
| argus.askSelection | Ctrl+Shift+Q | Ask about selected code |
| argus.editSelection | - | Edit selected code with AI |
| argus.reviewSelection | - | Code review of selection |
| argus.newSession | - | Start fresh conversation |

## Settings

| Setting | Default | Description |
|---------|---------|-------------|
| argus.model | _(CLI default)_ | Model to use (free-text; any CLI-supported name) |
| argus.inlineCompletions.enabled | false | Enable inline completions |
| argus.codeLens.enabled | true | Show code lens |
| argus.bash.useIntegratedTerminal | true | Run bash in terminal |
| argus.inlineCompletions.model | Codex-haiku-4-5 | Model for inline completions |

## Optimizations

See [docs/optimizations.md](docs/optimizations.md) for performance work (persistent CLI process in both `server/index.ts` and `src/agent/AgentSession.ts`, future prespawn idea, benchmarks).

## Research

- [.claude/researches/playwright-install-hang.md](.claude/researches/playwright-install-hang.md) - `yarn test:e2e:install` hangs on Windows: Playwright's bundled extractor deadlocks unzipping browser binaries (Defender locks `D3DCompiler_47.dll` mid-scan). Fix: manually download + `Expand-Archive` all four components (chromium, headless-shell, ffmpeg, winldd) and write `INSTALLATION_COMPLETE` markers.

## Conversation provider boundary

- Actual execution providers live in src/backend/providers. Claude Code retains its existing CLI/transcript paths; Codex uses app-server JSONL stdio. Do not infer runtime names from older synchronized descriptions above.
- On Windows, `AppServerRpc` prepends installed Git Bash to the Codex child `PATH` so direct Bash shell selection resolves to MINGW64 instead of WSL. Keep this environment change scoped to the Codex spawn; see [Codex shell resolution](!notes/common/codex-shell-resolution.md).
- SessionState.selection is the source of truth for provider/model/effort/thinking. Global config only seeds defaults. switchProvider creates a fresh entry; changing a model never changes another conversation.
- Native requests and approvals stay inside adapters. Reject unsupported RPC requests; never automatically replay a timed-out Codex turn. Only kill provider processes owned by Argus.
- Shared UI capabilities live in src/shared/provider.ts. Add providers through AgentProvider/AgentSession and registry.ts. Tests: npm run test:providers plus provider-picker.spec.ts and provider-switch-integration.spec.ts.
- The composer keeps Claude's Edit/Plan control. Codex uses Ask/Plan/Full; switching providers resets to Ask/Edit. Pass the chosen mode with each turn. Codex maps Full to approvalPolicy never, sandbox danger-full-access, and sandboxPolicy type dangerFullAccess; Ask keeps workspace-write with on-request approvals and Plan remains read-only.
