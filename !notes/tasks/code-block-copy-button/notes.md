# Code block copy button drifts on horizontal scroll

**Status:** fixed, uncommitted
**Reported:** 2026-08-21, screenshot of a scrolled markdown code block with the copy
button stranded mid-block

## Problem

In a chat message, a fenced code block wider than the pane scrolls horizontally. The
hover copy button, meant to sit in the top-right corner, slid left across the block as
the user scrolled right and eventually left the visible area entirely.

## Root cause

`webview/src/utils/markdown.tsx` made one element do both jobs: the `<pre>` was the
scroll container (`overflowX: 'auto'`) **and** the positioning context
(`position: 'relative'`) for the absolutely positioned button.

The general mechanism, the working shape, and how to verify it are repo-level knowledge:
[../../common/overlay-controls-on-scrollable.md](../../common/overlay-controls-on-scrollable.md).

## Changes made

- `webview/src/utils/markdown.tsx` - a non-scrolling wrapper `div` now owns
  `position: relative` + `width: fit-content`; the inner `pre` keeps background, padding
  and `overflow-x: auto`. `.code-block-wrapper` moved to the div, so the hover rules in
  `global.css` were untouched. The button's background went from `transparent` to
  `var(--tool-bg)`, because it is now permanently parked over code that scrolls beneath it.
- `e2e/code-copy-button.spec.ts` (new, mock) - position-under-scroll regression test plus
  a copy-still-works guard.

## Verification

- Chrome measurement after the fix: button right edge 4px inside the block at
  `scrollLeft = 0` **and** at `scrollLeft = 3687`; x/y identical to the pixel.
- Control run: re-nesting the button inside the `pre` from DevTools reproduced the
  -3691px drift.
- Red/green on the new spec: against the old structure the position test fails with
  `Received: 3453`; with the fix both pass, and 5 consecutive runs are clean.
- Full mock suite: 193 passed, 1 failed - `model-picker.spec.ts`, environmental, caused by
  running against the real `~/.claude/argus.json` rather than `e2e/argus.json`. Written up
  in [../../common/e2e-testing.md](../../common/e2e-testing.md) ("The `mock` project is not
  immune to the wrong config").
- `yarn build` re-bundled `media/webview.js` so the daemon-served browser UI and the
  extension panel pick the fix up; Vite on :5173 had it live already.

## Gotchas

- **The first explanation of the bug was wrong, and only a control run caught it.** The
  reasoning was that `right: 4` anchors to the *scrollable* right edge, so the button
  should sit at the end of the longest line and drift into view when scrolling right.
  Measurement showed the opposite: it is anchored at scroll origin and drifts left, out of
  view. The fix would have been identical either way, which is exactly the trap - a correct
  patch would have shipped with a wrong explanation in the comment and in this note.
- **The first version of the regression test failed for the wrong reason** (locator shape,
  not behavior), and its companion test passed against the broken code. Both are written up
  as conventions in [../../common/e2e-testing.md](../../common/e2e-testing.md) ("Run the red
  before trusting a regression test").
- **One unreproduced flake** in the clipboard test, immediately after relocating the config
  file; the error text was lost before it could be read and 11 subsequent runs were clean.
  Not diagnosed, but the test did contain a real race (reading the clipboard without
  waiting for `writeText` to resolve), which was closed by asserting the button's `✓` first.
  If it recurs, that assumption is the thing to re-check.

## Environment notes

Neither of the two blockers hit this session is specific to this ticket; both are already
covered in [../../common/e2e-testing.md](../../common/e2e-testing.md):

1. `e2e/global-setup.ts` refuses to run while a `yarn dev` started without `ARGUS_CONFIG`
   holds :3001. Worked around with the mock-only escape hatch
   ([../../common/scripts/playwright.mock-only.ts](../../common/scripts/playwright.mock-only.ts)),
   which was written during this task.
2. Playwright 1.59.1's bundled chromium is not installed on this machine
   (`chromium_headless_shell-1217` missing), so every browser test fails in
   `browserType.launch`. The documented fix is `node scripts/install-browsers-manual.js`;
   this session used `channel: 'chrome'` instead and did not repair the install, so
   `yarn test:e2e` is still broken machine-wide.

## Remaining work

- Commit (not requested). On commit, bump the version per the repo's habit and update this
  status line.
- Run `node scripts/install-browsers-manual.js` to restore the bundled chromium, then drop
  the `channel: 'chrome'` line from the mock-only config.
