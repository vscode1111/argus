# open-in-editor-browser: "Open in editor" button missing in browser mode

## Request

Follow-up to [../slow-image-preview/notes.md](../slow-image-preview/notes.md): once
image previews were fast, the user asked why a `.js` file preview opens instantly
while an image doesn't (answered: text content ships inline in the message, images
are deliberately stripped and fetched per click - architectural, not a bug). Then,
with a screenshot of a `.md` preview and a red box around the modal header between
the copy-path button and the encoding dropdown: "Add button here to open original
file like we have in VS code extension" - the existing `isVsCode`-gated "Open in
editor" button in `FileViewerModal.tsx`, present in the VS Code extension but absent
in browser mode (which is how the user was actually viewing Argus, per their
`localhost:5173/?session=...` screenshots).

## Design

Two options considered: (A) client-side `vscode://file/<path>:<line>:<col>` URI
navigation - no backend trust boundary crossed, works when VS Code is installed on
the viewer's own machine; (B) ask the backend to spawn a local editor process -
rejected, since Argus has a remote-access feature and a remote authenticated client
triggering local process launches on the *server* machine is a different risk class
entirely. Went with (A).

`vscode://file/` is not a guess: it's the same scheme Vite's own dev-server error
overlay uses to open a stack frame in the editor, and Vite is already a dependency
of this project. Verified the URI mechanics directly rather than trusting docs alone:
`Start-Process "vscode://file/d:/_Projects/scub111g/argus/CLAUDE.md:5:1"` (plain
ASCII case) and the same against the actual reported Cyrillic/hyphenated path
(`.../квартира-снегири-сиреневый-79/2026-09-17-листинг.md`) both returned exit code
0 with no error dialog. Confirming the *resulting* VS Code window on this machine
turned out to be unreliable via automation (multiple virtual desktops, and Electron
apps share one `MainWindowHandle` across all their top-level windows, so
`Get-Process`/UI-automation window enumeration under-reports which window actually
opened) - not pursued further past the exit-code + well-established-scheme evidence,
given the failure mode of a wrong/stale URI is inert (nothing happens, or an OS
"open with" prompt) rather than dangerous.

**Remote-access gate**: a path shown to a client names a file on the *server's*
filesystem. `vscode://file/` resolved on the *viewer's* machine can only reach it
when the browser and server are the same machine - so the button is additionally
gated on `isLocalHost` (`window.location.hostname` in `localhost`/`127.0.0.1`/`::1`),
client-side, no backend round trip. This mirrors (without reusing) the backend's own
`isLocalAddress` gate used for the remote-auth feature, applied to the equivalent
client-side question.

**Encoding**: `encodeURI`, not `encodeURIComponent` - the drive letter's colon and
the path separators must stay literal (`encodeURIComponent` would mangle `D:` into
`D%3A`), while spaces and non-ASCII segments still need escaping. Verified against
three cases: Windows path + line, the real Cyrillic/hyphenated path with no line,
and a POSIX path with a space + line
(`!notes/tasks/open-in-editor-browser/scripts/check-uri.js`).

**Navigation mechanism**: `window.open(uri, '_self')`, not `location.href = uri` -
matches the codebase's existing convention for opening something external (the login
link, the Account & Usage footer, `SettingsModal`'s claude.ai link all use
`window.open`), and is what the existing `url-not-file-path.spec.ts` spy pattern is
built to intercept. `_self` because a custom-protocol handoff never actually
navigates the page away (confirmed manually: page URL and app state were unchanged
after the click) - the browser hands it to the OS and the SPA keeps running, so no
new tab is needed.

## Gotcha: two existing specs asserted the old absence

`file-path-links.spec.ts` ("image modal has no encoding dropdown") and
`preview-navigation.spec.ts` ("no \"Open in editor\" button in browser mode") both
explicitly asserted the button was **absent** outside VS Code. Both run against
`localhost:5173`, so `isLocalHost` is true for them and the button now renders -
found by grepping `e2e/` for `Open in editor` rather than assuming the new gate
couldn't regress anything. Fixed: the image-modal test now asserts count 1 (the
button was never `!isImage`-gated even in VS Code mode, so this is parity, not a new
inconsistency); the preview-navigation test was rewritten to spy on `window.open`
(mirroring `url-not-file-path.spec.ts`'s `spyOnOpen` helper) and assert the emitted
URI starts with `vscode://file/`, names the clicked file, and that the page itself
stays on the previewer.

## Verification

- Rebuilt (`yarn build`) and drove the real dev server through Playwright: button
  renders in the same header slot as the VS Code version, click produces no console
  errors and does not navigate the SPA away.
- `npx playwright test --project=mock e2e/preview-navigation.spec.ts
  e2e/file-path-links.spec.ts` - 23/23 passed, including the rewritten tests.
- `npx playwright test --project=mock e2e/file-viewer-modal.spec.ts
  e2e/html-preview.spec.ts e2e/modal-persistence.spec.ts` - 16/16 passed (no other
  spec asserts a raw button count in the modal header that a new button could break).
- `tsc --noEmit -p webview/tsconfig.json` - the one error present is a pre-existing
  `SyntaxHighlighter` JSX-typing mismatch, unrelated to this change (confirmed via
  `git stash` on just the two touched files: same error, same file, only the line
  number shifts).

## Files changed

- `webview/src/utils/path.ts` - new `vscodeFileUri(path, line?)`
- `webview/src/components/FileViewerModal.tsx` - `isLocalHost` const, dual-path
  `openInEditor`, render gate widened from `isVsCode` to `isVsCode || isLocalHost`
- `e2e/preview-navigation.spec.ts` - `spyOnOpen`/`opened` helpers; rewrote the stale
  absence test into a presence + correct-URI test
- `e2e/file-path-links.spec.ts` - flipped the stale `toHaveCount(0)` to
  `toHaveCount(1)` for the image-modal case
- `CLAUDE.md` - updated the "File previewer navigation" bullet, the `path.ts`
  structure-listing line, and the `preview-navigation.spec.ts` one-liner

## Remaining work

None known. Not built: a negative test for `isLocalHost` being false (would need to
stub `window.location`, which is fragile in Playwright and low-value against a
one-line array-membership check).
