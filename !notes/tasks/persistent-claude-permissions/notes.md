# Persistent Claude permissions

## Goal

Keep Claude's selected permission level across conversations and page reloads. Default to Full when none has been saved.

## Implementation

Claude uses its own `argus.claudePermissionMode` localStorage key, separate from Codex. Its picker offers Edit, Plan, and Full. Full sends the existing `full-access` wire mode, and the Claude backend maps that mode to `--permission-mode bypassPermissions`; Codex keeps its own sandbox mapping. Changing modes changes the Claude process key, so the next turn respawns the CLI with the new permission mode.

## Verification

- `yarn.cmd compile` and `yarn.cmd build` passed.
- A fresh mock browser context showed Full for both providers. Selecting Claude Plan left Codex Full unchanged, and a new tab restored Claude Plan.
- `provider-picker.spec.ts` covers the same defaults and persistence. The Playwright harness was not run because its shared live dev server uses the user's config instead of the isolated e2e config.
