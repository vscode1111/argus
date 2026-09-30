# Browser command text color differs from VS Code

## Problem

In the same transcript, shell commands are yellow in the browser and blue in the VS Code panel. This was identified after the preceding typography fix.

## Reproduction

On `main`, with the dev server on port 5173 and the backend on port 3001, run `node !notes/tasks/browser-webview-colors/scripts/reproduce.js`. The script injects a sanitized Bash tool row in mock mode and checks its computed text color in both browser hosts.

Before the fix, the first page reported `rgb(220, 220, 170)`; the expected VS Code theme color is `rgb(117, 190, 255)`, so the assertion failed.

## Root cause

`ToolCall.module.css` colors Bash summaries with `--vscode-symbolIcon-variableForeground`, falling back to yellow `#dcdcaa`. VS Code supplies the variable. Neither browser HTML host supplied it, so both used the fallback. The installed VS Code 2026 Dark theme inherits the workbench default `#75BEFF` for this variable. The mismatch is in the host theme variables, not in the shared component.

## Fix

Define `--vscode-symbolIcon-variableForeground: #75BEFF` in both browser hosts. The VS Code panel continues to use its active theme value.

## Verification

- Before: `rgb(220, 220, 170)` in the dev browser, assertion failed.
- After: the same script passed on ports 5173 and 3001, both reporting `rgb(117, 190, 255)`.
- `npm.cmd run build` and `git diff --check` passed.

## Related tasks

- [Browser typography](../browser-webview-density/notes.md)
- [Browser host theme parity](../../common/browser-host-theme.md) holds the reusable host rule.
