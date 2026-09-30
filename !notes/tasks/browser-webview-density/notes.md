# Browser typography differs from the VS Code panel

## Problem

The browser view at `localhost:5173` looked denser than the VS Code extension in the two screenshots supplied on 2026-09-29. The task is to align the browser styling with the extension while keeping the extension's theme integration.

## Reproduction

On `main` at `d57e328`, with the existing `npm run dev` servers on ports 5173 and 3001, run `node !notes/tasks/browser-webview-density/scripts/reproduce.js`. It opens the dev browser at `/?mock=1`, injects a sanitized two-file `fileChange`, and measures the computed font and vertical distance between its file rows. The expected row spacing from the VS Code screenshot is 18 pixels. Before the fix the browser used `Cascadia Code`, measured 17 pixels, and the assertion failed (`17 !== 18`). The supplied screenshots measured 17 pixels between the browser file rows and 18 pixels between the corresponding extension rows at their native resolutions.

## Root cause

Both browser HTML hosts hardcoded `--vscode-editor-font-family` to `Cascadia Code`, while this Windows VS Code installation uses the standard Consolas monospace stack. The variable feeds the shared `--font-mono` used by file changes and command rows. In a browser-only toggle with all other styles held constant, Cascadia Code produced 17-pixel file-row spacing, Consolas 18, and Courier New 17. The same source CSS bundle and 13-pixel body size were in use across the hosts. The counter-hypothesis that VS Code injected a different line-height was checked against its local webview bootstrap: it does not set line-height, and the browser's computed value was `normal`.

## Fix

Use `Consolas, "Courier New", monospace` for `--vscode-editor-font-family` in both browser HTML hosts. The VS Code panel continues to receive its own theme variable from the editor. No shared component spacing or font-size rules changed.

## Verification

- Before: the reproduction failed with `monoFont` set to Cascadia Code and `fileRowSpacing: 17`.
- After: the same command passed with `monoFont` set to Consolas and `fileRowSpacing: 18`.
- The server-hosted browser page also computed `Consolas, "Courier New", monospace`.
- The six neighboring file-change browser tests passed after the font change.
- `npm.cmd run build` and `git diff --check` passed.

## Files changed

- `webview/index.html`
- `media/browser.html`
- `scripts/reproduce.js`

## Gotchas

The two screenshots have different widths, so their display scaling alone cannot establish a font-size mismatch. The comparison used original pixels and a same-viewport browser probe.

## Decisions

The change is limited to browser host theme variables. It does not override the user's VS Code theme or editor font preference.

## Related tickets

- [Codex file status](../codex-file-status/notes.md)
- [Browser host theme parity](../../common/browser-host-theme.md) covers the reusable styling rule.
