# Dialog state persistence (localStorage) + "Reset layout" button

Worked on `main` (no ticket). Flipped the centered-dialog geometry/tab store from in-memory to `localStorage` so each modal's position, size, and selected tab survive a full page refresh, and added a Settings "Reset layout" button to wipe it back to defaults.

## Why

The store (`webview/src/utils/dialogState.ts`) was deliberately in-memory (a module-level `Map`) so it reset on reload. The request was the opposite: persist position/size/tab across refreshes, with an explicit button to clear them. So the design intent inverted - persistence is now the goal, and the button is the escape hatch.

## Changes

- **`utils/dialogState.ts`** - same `getDialogState`/`patchDialogState` API (so `useDialogGeometry`, `SessionHistoryModal`, `WorkspaceHistoryModal` need no changes), now backed by a single `localStorage` key `argus.dialogState` holding `Record<key, {pos,size,tab}>`, read/written per call. Storage errors are swallowed (geometry is best-effort, never throws). New `clearDialogState()` removes the key.
- **`hooks/useDialogGeometry.ts`** - returns a new `reset()` that clears the live element's inline `width`/`height` (back to `defaultWidth`/`fullHeight` or CSS default) and recenters via `setPos(null)`. Lets "Reset layout" snap the *open* modal back without a reopen.
- **`components/SettingsModal.tsx`** - bottom-right **"Reset layout"** button (`.resetCorner`, mirrors the bottom-left `dev` button). Handler calls `clearDialogState()`, removes `argus.settingsTab` (the Settings tab lives in its own localStorage key), `drag.reset()`s the open modal, and flashes "Layout reset" for 1.5s.
- **CLAUDE.md** - updated the `dialogState.ts` line, the "Dialog state persistence" convention bullet, and both dialog-state e2e descriptions.

## Tests

- `e2e/dialog-state.spec.ts` (mock): the old "resets to defaults after a page refresh" test was inverted to "persists tab and size across a page refresh"; added a "Reset layout wipes the saved tab and size" test.
- `e2e/dialog-state-integration.spec.ts` (integration): the three reset-on-refresh assertions (Session History, Account & Usage, Settings) now assert persistence across refresh; Session History + Settings also exercise the Reset layout button. Added a **cross-dialog** test: seed state in two different dialogs (Session History tab+size, Account & Usage size), assert both land in `argus.dialogState`, click Reset layout once, assert both entries are gone, and after a real refresh both dialogs reopen at their defaults (440 / 380 width). Full integration suite is green.

## Files changed

| Path | What |
|------|------|
| `webview/src/utils/dialogState.ts` | localStorage backing (`argus.dialogState`); `clearDialogState()` |
| `webview/src/hooks/useDialogGeometry.ts` | `reset()` to snap the live element back to default geometry |
| `webview/src/components/SettingsModal.tsx` | "Reset layout" button + handler (`clearDialogState` + remove `argus.settingsTab` + `drag.reset()` + 1.5s flash) |
| `webview/src/components/SettingsModal.module.css` | `.resetCorner` (bottom-right, mirrors `.devCorner`) |
| `e2e/dialog-state.spec.ts` | persist-across-refresh + Reset layout (mock) |
| `e2e/dialog-state-integration.spec.ts` | persist-across-refresh + Reset layout + cross-dialog clear (integration) |

## Gotchas

- **Reset re-records the open modal's default size.** `drag.reset()` shrinks the *currently open* Settings modal, which fires its `ResizeObserver`, which writes the new (default) size straight back into `argus.dialogState` under `settings`. So right after a reset the store is not fully empty - it holds the Settings modal's default geometry. Harmless (it's the default, and every *other* dialog's entry is gone), but don't assert "store is empty" after a reset while Settings is open; assert the specific dialog keys are absent instead.
- **e2e off-screen footer.** Once geometry persists across refresh, the shared `dragAndResize` helper (moves the modal down ~70px, then grows it to 480px tall) leaves the bottom-right "Reset layout" button below the 720px Playwright viewport, so the click can't land ("element is outside of the viewport"). Pull the modal back on-screen first (`el.style.top = '40px'`) before clicking; the reset recenters it anyway, so no later assertion is affected.
- **Two separate tab stores.** SettingsModal keeps its tab in `localStorage` `argus.settingsTab` (not in the dialog store), while Session/Workspace History keep their tab in `argus.dialogState`. "Reset layout" must clear both, which is why the handler removes `argus.settingsTab` explicitly.
