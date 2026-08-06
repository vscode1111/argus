# workspaceInfo config restore (stale model picker in extension panels)

## Problem

An extension panel's model picker showed the checkmark on "Default (CLI), currently claude-sonnet-5" and "Effort (High)" while the very session answering was running `claude-fable-5 --effort max`. Verified live: `~/.claude/argus.json` had `model: "claude-fable-5"`, and the answering CLI process command line (walked via Win32 ancestor chain) carried `--model claude-fable-5 --effort max`, spawned by the 0.0.82 daemon. The "Currently claude-sonnet-5" caption itself was correct (`runtimeDefaultModel`; the CLI default is pinned to `sonnet` in `~/.claude/settings.json`) - only the checked row was wrong.

## Root cause

Two responders build the `workspaceInfo` reply to `getInfo`, and they drifted:

- Server (`session.ts`): sends `model`/`effort`/`thinking` fresh from `readConfig()` (the 0.0.82 config-global refactor). Browser mode uses this path and was correct.
- Extension: `getInfo` is `VS_ONLY`-routed (`media/chat.html`), so `ChatPanel.onWebviewMessage` answers it - with only `{path, version}`. The reducer merges those fields only when defined, so `currentModel`/`currentEffort` stayed at their initial `''`/`high` on every webview load; only a live `modelChanged`/`effortChanged` broadcast ever showed the truth, and any reload lost it again.

## Changes made

- `src/backend/workspaceInfo.ts` (new): `buildWorkspaceInfo(path, version, fallbackModel?)` - single builder of the reply, model/effort/thinking read fresh from argus.json.
- `src/backend/session.ts`: getInfo replies via the builder (`s.serverDefaultModel` as fallback; semantics unchanged).
- `src/frontend/chat/ChatPanel.ts`: getInfo replies via the builder (no fallback), so extension panels restore config-global state on load.
- `e2e/workspace-info-config-integration.spec.ts` (new, 4 tests): builder field passthrough + fallback semantics against real temp config files in a child process (ARGUS_CONFIG resolves at config.ts import time, hence the child), and the server path end-to-end through the UI (patch e2e/argus.json -> fresh load -> picker checkmark/effort label/thinking toggle; Default (CLI) when empty). Serial, restores e2e/argus.json in afterAll.
- CLAUDE.md: structure line, e2e list entry, model-data bullet extended.

## Verification

- New spec 4/4 passed; `shared-channel-integration` (11/11, covers getInfo after switchModel) passed after the refactor; full `yarn compile` + `yarn build` clean.
- `yarn ext:install` run twice on this machine (inline fix, then the builder refactor); VS Code window reload is the user's remaining step to load the new ChatPanel.

## Remaining work

- Not committed yet.
- Known adjacent gap (documented in [model-picker-refresh notes](../model-picker-refresh/notes.md)): the webview does not re-post `getInfo` on `ws_status connected`, so a daemon restart can still leave a stale display until reload. Out of scope here.
