# File/diff/image previews closing during an active session

Worked on `main` (no ticket), 2026-08-21. User report: "File modals, diff and image ones are closed during active session."

## Root cause

The open state lived in the component that was clicked, and that component does not survive the turn.

A tool block is rendered by `StreamingMessage` while its turn runs, and by `ChatMessage` once `done` commits the streaming blocks into a `UIMessage`. Those are different components, so at the moment the turn finishes React unmounts the `ToolCall` that owned `viewerOpen` / `diffOpen` and mounts a fresh one - taking the modal down with it, under the cursor of someone reading it. `FilePathLink` (in `utils/filePath.tsx`) had the same problem plus a second one: it lives inside markdown that is re-rendered on every `text_chunk`.

The `createPortal(..., document.body)` these modals already use fixes **stacking**, not **lifetime** - the portal's content is still unmounted with its owner. Easy to misread the existing "Modal portals" convention as covering this.

Note what was *not* broken, since it shaped the fix: previews survived mid-stream events (`text_chunk`, `tool_start`) and survived the next turn starting. Only the commit boundary killed them.

The general rule this produced, for any state that must outlive a turn (not just previews): [../../common/state-lifetime-in-message-tree.md](../../common/state-lifetime-in-message-tree.md).

## Fix

`webview/src/contexts/PreviewContext.tsx` (new): `PreviewProvider` sits above `AppInner` in `App.tsx` and owns every preview. Consumers call `usePreview().open(req)`.

- `PreviewRequest` is `{kind:'file'|'diff'|'path'}`. `path` means "no content in hand" - the host posts `readFilePreview` itself and pushes the frame only when the reply lands, which deleted two near-identical copies of that fetch (`ToolCall`'s image branch and `FilePathLink`).
- State is a **stack**, not a single slot: previewed markdown linkifies paths too, so a path clicked inside a preview must open on top of it rather than replace it (that was the old nested-modal behaviour). `onClose` at depth i truncates to i.
- `refresh(req)` updates an already-open entry matched by `key` (`<toolCallId>:file` / `:diff`), so a background Bash task's output still reaches an open modal instead of freezing at the snapshot taken when it was opened.

## Tests

`e2e/modal-persistence.spec.ts` (mock + WS, new), 6 tests: diff / file output / image opened mid-turn survive `done`; a file-path link in streaming markdown survives `done`; and the two controls that were never broken (mid-stream events, next turn starting). The image and link cases fetch through the real backend, so they also cover the host's `readFilePreview` round trip.

**Red-run verified**: with the three source files stashed and the bundle rebuilt, exactly the four "survives the turn finishing" tests failed and the two controls passed; after `git stash pop` + rebuild, all six passed. Rebuilding is the part that is easy to forget - the recipe and why the controls matter are in [../../common/e2e-testing.md](../../common/e2e-testing.md) ("Run the red before trusting a regression test").

Full suite afterwards, against the correct `e2e/argus.json` (the user stopped their own dev server): **mock 204 passed / 0 failed**, **integration 124 passed / 3 skipped / 0 failed** (5.2 min), including `file-preview-copy-integration.spec.ts`, which is the integration cover for the refactored preview path.

## Files changed

| Path | What |
|------|------|
| `webview/src/contexts/PreviewContext.tsx` | new: `PreviewProvider`, `usePreview`, request stack, path resolution |
| `webview/src/App.tsx` | wrap `AppInner` in `PreviewProvider` |
| `webview/src/components/ToolCall.tsx` | drop `viewerOpen`/`diffOpen`/`imagePreview` + both modal renders; `fileRequest()` builder, `openFilePreview()`, refresh effect |
| `webview/src/utils/filePath.tsx` | `FilePathLink` is now just a link that calls `open({kind:'path'})` |
| `e2e/modal-persistence.spec.ts` | new regression spec |
| `CLAUDE.md` | new "Preview ownership" convention, contexts tree entry, e2e table |

## Gotchas

- **`ToolCall` already had a local `const preview`** (the truncated result string shown when `showOutput` is on). Naming the hook result `preview` shadowed it and broke the inline output; the hook is `previewer` there.
- **The webview is never typechecked by any script**, which is how `FilePathLink` came to pass an `endLine` prop `FileViewerModal` does not accept - `:12-80` ranges had been silently scrolling to the start line only. Dropped the dead prop here; the range is still part of the link text. The check to run and the other error it surfaces: [../../common/development.md](../../common/development.md).
- **The user's own `yarn dev` was running on :3001 with the real config**, so `e2e/global-setup.ts` (correctly) refused every run. Used [../../common/scripts/playwright.mock-only.ts](../../common/scripts/playwright.mock-only.ts) rather than stopping their server. Its documented cost showed up exactly as written: `model-picker.spec.ts` fails because the real config pins `model: "claude-opus-5"` while `e2e/argus.json` has `""`, and the active-model checkmark comes from the server's `workspaceInfo` (`getInfo` is not in `MOCK_SUPPRESSED`). Confirmed by diffing the two configs, not assumed.
- **`git stash push -- <paths>` stages everything else** as a side effect. After the red run, `git reset` was needed to put the unrelated staged files back to unstaged.

## Remaining work

None for the reported bug. Not addressed (out of scope, not user-visible today): `ChatMessage`'s and `InputArea`'s `ImageViewerModal` still own their state locally - both are mounted by components with stable lifetimes (a committed user message, the input box), so neither can hit this. If a preview is ever opened from a block that can move between messages, route it through `usePreview` instead.
