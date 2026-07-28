# Issues

Tracked bugs / investigations with reproduction, root-cause analysis, and attempt logs.

| Issue | Status | Summary |
|-------|--------|---------|
| [toast-click-focus-cross-desktop](toast-click-focus-cross-desktop.md) | open / unverified fix | Clicking the notify-on-complete Windows toast does not bring VS Code forward across virtual desktops. In-process focus from the background extension host is refused by Windows (proven via `%TEMP%\argus-focus.log`); a fresh `argus-focus://` -> VBS -> PS1 foreground-righted helper is built but not yet verified. |
| [integration-suite-cascade-crash](integration-suite-cascade-crash.md) | resolved / verified | 29 integration tests failed at once, but it was one cascade: evicted `SessionEntry`s never killed their CLI process, the pileup exhausted the OS, and `spawn()`'s **synchronous** throw (`spawn UNKNOWN`) killed the whole backend. Fixed with a try/catch around `spawn`, `killProc` on entry eviction, and the `workers: 2` integration cap that CLAUDE.md documented but the config never had. |
| [file-viewer-grey-line-boxes](file-viewer-grey-line-boxes.md) | resolved / verified | FileViewerModal painted a grey box behind every code line, but only in the extension (not the browser dev server). Root cause: VS Code injects a default webview stylesheet that fills `<code>` with a `#262626` background; fix is `codeTagProps={{ style: { background: 'transparent' } }}`. Diagnosed via an in-extension computed-style probe (`selRanges=0`, `code=rgb(38,38,38)`). |
