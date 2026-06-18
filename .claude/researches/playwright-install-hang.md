# Research: `yarn test:e2e:install` hangs on Windows (Playwright browser extraction deadlock)

**Date:** 2026-06-18
**Environment:** Windows 10 Pro, Playwright (`@playwright/test`) v1.59.1, chromium build 1217.

## Symptom

`yarn test:e2e:install` (which runs `npx playwright install chromium`) prints the
download progress bar, reaches `100% of 179.4 MiB`, and then never finishes - it
hangs indefinitely (5+ minutes with no further output).

## Root cause

The **download** is not the problem; it completes every time. The hang is in the
**extraction** step.

Playwright downloads each browser zip to `%TEMP%\playwright-download-*`, then calls
its bundled yauzl-based extractor (`extract()` at
`node_modules/playwright-core/lib/server/registry/oopDownloadBrowserMain.js:106`)
to unzip it into `%LOCALAPPDATA%\ms-playwright\<browser>\`. Only after a successful
extract does it write the `INSTALLATION_COMPLETE` marker file.

On this machine the extractor consistently dies right after writing
`D3DCompiler_47.dll` - exactly 3 files land in `chrome-win64\` (`.manifest`, `ABOUT`,
`D3DCompiler_47.dll`), `chrome.exe` is never written, and no `INSTALLATION_COMPLETE`
marker is created. This is the signature of **Windows Defender locking the DLL while
it real-time-scans it mid-write**, which deadlocks the extractor's write-stream
callback - it waits forever and the whole install stalls.

A partial folder left behind is dangerous: Playwright may treat the browser dir as
present on a later run and the tests then fail with a confusing "browser not found".

## How Playwright decides to skip a download

`browserFetcher.js:46` - if `<browserDir>\INSTALLATION_COMPLETE` exists, the browser
is considered "already downloaded" and the download/extract is skipped. So writing an
empty marker after a manual extract is enough to satisfy Playwright.

## Components required by `install chromium`

`npx playwright install chromium` installs **four** components on Windows, each of
which must be extracted and markered. The `winldd` one (a Windows-only DLL dependency
checker) is easy to forget and was the reason a first manual pass still hung.

| Component | Target dir | Executable | Zip URL |
|-----------|-----------|-----------|---------|
| chromium | `chromium-1217\chrome-win64\` | `chrome.exe` | `https://cdn.playwright.dev/builds/cft/147.0.7727.15/win64/chrome-win64.zip` |
| chromium-headless-shell | `chromium_headless_shell-1217\chrome-headless-shell-win64\` | `chrome-headless-shell.exe` | `https://cdn.playwright.dev/builds/cft/147.0.7727.15/win64/chrome-headless-shell-win64.zip` |
| ffmpeg | `ffmpeg-1011\` | `ffmpeg-win64.exe` | `https://cdn.playwright.dev/builds/ffmpeg/1011/ffmpeg-win64.zip` |
| winldd | `winldd-1007\` | `PrintDeps.exe` | `https://cdn.playwright.dev/builds/winldd/1007/winldd-win64.zip` |

All under `%LOCALAPPDATA%\ms-playwright\`. Get the exact dirs/URLs for any version
from the registry instead of hardcoding:

```sh
node -e "const r=require('./node_modules/playwright-core/lib/server/registry'); \
  const e=r.registry.findExecutable('chromium'); \
  console.log(e.directory, e.executablePath(), JSON.stringify(e.downloadURLs))"
```

## Fix (no admin required) - manual download + extract

For each component: download the zip with `curl`, extract with PowerShell
`Expand-Archive` (does not deadlock the way yauzl does), then write an empty
`INSTALLATION_COMPLETE` marker in the browser dir.

```sh
# example for chromium; repeat per component
ROOT="$LOCALAPPDATA/ms-playwright"
curl.exe -L -f --retry 3 -o "$TEMP/chromium.zip" \
  "https://cdn.playwright.dev/builds/cft/147.0.7727.15/win64/chrome-win64.zip"
powershell -NoProfile -Command \
  "Expand-Archive -LiteralPath '$TEMP\chromium.zip' -DestinationPath '$ROOT\chromium-1217' -Force"
# only after verifying chrome.exe exists:
printf '' > "$ROOT/chromium-1217/INSTALLATION_COMPLETE"
```

(A throwaway Node script that loops over all four components is the convenient form -
download, `Expand-Archive`, verify exe, write marker.)

## Verifying success

```sh
DEBUG=pw:install npx playwright install chromium
```

Every component should log `... is already downloaded` followed by
`validation passed`. Then smoke-test an actual launch:

```sh
node -e "const {chromium}=require('playwright-core'); (async()=>{const b=await chromium.launch(); await b.close(); console.log('OK');})()"
```

## Gotchas

- `timeout 60 yarn ...` kills only the parent on Windows; orphaned
  `oopDownloadBrowserMain.js` children keep running and look like a fresh hang.
  Kill stragglers by matching `playwright install|oopDownload` in the command line.
- Running two installs concurrently makes it worse (both fight over the same
  `chromium-1217` folder).
- Clean up leftover `%TEMP%\playwright-download-*` dirs afterward; the chromium ones
  are ~180 MB each.

## Root-cause alternative (needs admin)

Add a Microsoft Defender exclusion for `%LOCALAPPDATA%\ms-playwright` (and `%TEMP%`),
then run the normal installer - extraction no longer deadlocks because Defender stops
locking files mid-write.
