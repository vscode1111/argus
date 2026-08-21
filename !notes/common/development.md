# Local development setup

## Nothing typechecks `webview/` - run it by hand

No script in this repo typechecks the webview. `yarn build` is `vite build`, which uses
esbuild: types are **stripped, never checked**. `yarn compile` is `tsc -p ./`, whose
`include` is `["src/**/*"]` - `webview/` is outside it. So a webview type error survives a
green build, a green compile, and a green e2e run; only the editor shows it.

```sh
npx tsc -p webview/tsconfig.json --noEmit
```

Worth running after any webview refactor. Two errors were sitting there undetected when this
was first run (2026-08-21):

- `FilePathLink` passing an `endLine` prop `FileViewerModal` does not declare - i.e. `:12-80`
  ranges had been silently scrolling to the start line only, with no other effect. Real bug,
  invisible to every check in CI.
- `SyntaxHighlighter` "cannot be used as a JSX component" in `FileViewerModal` - a
  React 18 / `@types/react-syntax-highlighter` version mismatch, cosmetic, still open.

Expect that second one in the output; anything else is new.

## `C:` drive full breaks `yarn install`

This dev machine's `C:` drive can run completely out of space (0 bytes free per `wmic logicaldisk get caption,freespace,size`), which fails `yarn install` with `ENOSPC: no space left on device, write` while extracting packages, even though the project itself lives on `D:` (which has hundreds of GB free). The cause is yarn's global cache, which defaults to `C:\Users\Admin\AppData\Local\Yarn\Cache` regardless of where the project sits. This is a package-manager symptom, not a project problem - it shows up as soon as `node_modules` needs a fresh install (e.g. a clean checkout, or `node_modules` never having been installed).

Workaround, without touching anything on `C:`:

```bash
mkdir -p /d/_yarn-cache-tmp
yarn install --cache-folder "D:/_yarn-cache-tmp"
```

Check free space first if `yarn install` / `yarn build` / `yarn compile` fail with `ENOSPC`:

```bash
wmic logicaldisk get caption,freespace,size
```

If `C:` is at or near 0 free, that is the root cause, not a bug in this repo's tooling.

## Stuck loading spinner after restarting `yarn dev`

A browser tab left open from a previous `yarn dev` process can get stuck on the app's loading spinner (`#root` never mounts, just the `.app-loader` spinner) after the dev server behind it is stopped and restarted - even though the new server instance is fully healthy. Confirmed healthy by loading the exact same URL in an unrelated browser context, where it mounted immediately (WS showed "Connected"), and by checking that every request (`GET /`, `/src/index.dev.tsx`, `/nonce`, etc.) returned 200. So this is client-side state in that specific tab, not a server problem - do not spend time re-checking `yarn dev`'s own output once you've confirmed it started cleanly (`VITE ... ready`, `WebSocket agent ready`, no `EADDRINUSE`).

Fix: hard refresh the stuck tab (`Ctrl+Shift+R` / `Ctrl+F5`), not a plain reload - confirmed to resolve it. If that doesn't help, try a private/incognito window to rule out extensions or other cached state.

Not confirmed as the cause here, but worth checking first if hard refresh doesn't help: this machine also runs VPN/proxy software (OpenVPN, Hiddify). If the affected browser routes local traffic through one, that can interfere with `localhost`/LAN requests in that browser specifically while an unaffected browser loads the same URL fine.
