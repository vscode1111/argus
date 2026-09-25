# video-preview: play audio and video in the previewer instead of hanging on them

## Goal

Clicking a `.mp4` path link opened a preview that never resolved. The request was to
"add support of video content" and, when asked, specifically **a media player like on
YouTube** - not merely a fix for the garbled output.

## The defect

`readFilePreview()` had branches for directories and images; everything else fell
through to `fs.readFileSync(filePath, 'utf-8')`. Measured against the running dev server
with the exact file from the report
(`people/shesterikova-anna/media/stories/2026-09-21-story-3991301238587252653.mp4`):

| | |
|---|---|
| File | 21.5 MB `.mp4` |
| WebSocket frame sent | **51.0 MB** (2.37x - binary re-encoded as UTF-8) |
| Reply latency (localhost) | 1.1 s |
| Decoded content | 21,366,052 chars, opens `\0\0\0 ftypisom` |
| Newlines, i.e. rendered line elements | **87,580** |

Two corrections to first guesses, both made against measurements rather than reasoning:

1. **The 20 s `PREVIEW_TIMEOUT_MS` never fires.** The reply arrives in 1.1 s, so the
   frame *is* delivered and the timeout is cancelled. Nothing was ever going to rescue
   the spinner.
2. **The render does complete** - the first hypothesis was that Prism wedged forever.
   Checked in the browser: 87,581 `<span data-line>` elements really do get built. So
   locally the symptom is "spinner for many seconds, then binary garbage", and the
   *endless* part belongs to the remote case, where 51 MB over the tunnel is the wait.

`readFileSync` is also synchronous, so the 513 ms decode blocked the event loop for
every other client of that server.

## Acceptance criteria

| # | Criterion | Evidence |
|---|---|---|
| 1 | A clicked `.mp4` opens a player with native controls, first frame in ~1 s regardless of size | Real 21.5 MB file in the browser: `readyState 4`, `duration 48.99` (the transcript calls it "49 секунд"), `720x1280`, `currentTime` advanced, no error. Screenshot showed `0:10 / 0:48`, scrubber, volume, PiP, fullscreen, overflow menu |
| 2 | No WebSocket frame carries media bytes | Grant frame measured at **255 chars** against the same file that used to produce 51 MB. Asserted in both specs (`frameBytes < 600`) |
| 3 | Seeking does not download the whole file | Seek to 45 s completed in 116 ms; the network log shows `content-range: bytes 21463040-22546902/22546903` - **1.03 MB of 21.5 MB**, the tail only. All nine media requests were `206` |
| 4 | Video in a directory listing has its own icon and opens | `stories/` listing: three `.mp4` rows at `rgb(204, 62, 68)` (Seti red `#cc3e44`) beside a blue folder. Clicking one opened the player at `duration 12.03` (the "12 сек" story) with a Back button |
| 5 | Undecodable media gives a readable card, never a spinner or garbage | Fixture with a media extension and no valid stream: "This video cannot be played here / 64 KB · video/mp4 / The browser has no decoder…", `preview-loading` absent, `[data-line]` count 0 |
| 6 | A remote client is refused | `probe-media-auth.js`: loopback control served **206**, same token from a non-local peer address **401** with no bytes, bogus token from remote **401** (refused at auth, not 404) |

Extra, from question 3 in the plan: a non-media binary is described rather than decoded
(`Binary file / 8.8 KB · nothing to display as text`), with the control that plain text
**still renders** (41 lines, encoding select present) - without it, "call everything
binary" would have passed.

Audio (question 1): a synthesized 3 s WAV renders `<audio>` and no `<video>`, decodes,
plays, and captions itself `23 KB · audio/wav`.

## Out of scope

Custom player chrome, transcoding, inline autoplay inside the chat stream, editing.
Native controls only.

## Prior art

The image preview, and it is the direct model. `!notes/common/large-tool-payloads.md`
had already established the rule this feature is a second instance of: a Read of an
image shipped 23.4 MB inside a 24.2 MB `sessionLoaded` payload that nothing rendered,
and the fix was to strip at every boundary and fetch on demand by an id the protocol
already has. Video is the same defect one size up, with one difference that changes the
mechanism: an image can still be sent as base64 once the user asks for it, whereas a
video must be *streamed*, or nothing plays until all of it has arrived and seeking is
impossible.

Reused verbatim: the `{kind:'path'}` optimistic-open-then-settle flow in
`PreviewContext`, the `matchesRequestedPath` suffix matching, the request/reply
invariant (answer even on failure), and `ToolCall.tsx`'s precedent of deciding by
extension on the client.

## Design

**Delivery is an HTTP range endpoint, not the WebSocket.** Base64 over WS would have
been worse than the bug: ~29 MB for this file, nothing playable until it all landed, no
seeking. The user watches this over a remote link, so payload size is a standing
constraint (`argus-used-over-internet`).

**The HTTP layer takes no path.** `src/backend/index.ts` keeps a fixed static allowlist
specifically so there is no arbitrary-path read over HTTP, and a `?path=` media route
would have reversed that. Instead:

```
webview  --mediaUrl {path}-->  session.ts   (WS: already authenticated + origin-checked)
                               readFilePreview(path, workspaceDir)   <- same validation
                               grantMedia(...) -> opaque 24-byte token
         <--mediaGrant {token, port, kind, mediaType, size}--
<video src="http://<host>:<port>/media/<token>?auth=...">
```

Traversal is not defended against at the HTTP layer, it is **unrepresentable** there:
`/media/<token>` can only serve a file some client was already allowed to preview.

- Grants: in-memory, 6 h sliding TTL (refreshed per request, so an hour-long file never
  goes stale mid-playback), capped at 200 with oldest-first eviction, and reused per
  path so reopening does not mint a token per click.
- Remote peers additionally need a live session (`isValidSession`), matching `/nonce` -
  the token travels in a URL, and URLs leak in ways WS frames do not.
- The file is re-`stat`ed per request rather than trusting the grant's recorded size,
  since the agent may have rewritten it; a stale `Content-Length` stalls a player.
- `res.on('close')` destroys the read stream, or every scrub leaks an abandoned read.

**Two detection sites, deliberately.** The webview decides by extension and goes
straight to `mediaUrl` (one round trip, mirroring `ToolCall.tsx`'s `IMAGE_EXTS`), while
`filePreview.ts` keeps its own media branch as the **guard** - it must never read a
video as UTF-8 no matter who asks. The lists mirror each other across the
frontend/backend tsconfig boundary, the same duplication `plural()` already has.

**CSP had to change in all three hosts**, and they differ:

| Host | Was | Why it blocked media |
|---|---|---|
| `media/chat.html` | `default-src 'none'`, no `media-src` | blocks everything; added `media-src http://localhost:*` |
| `media/browser.html` | `default-src 'self'` | works by fallback, but spelled out so a later tightening cannot break playback silently |
| `webview/index.html` | `default-src 'self'` | **wrong origin**: page on `:5173`, server on `:3001` |

**Origin derivation never uses `localhost`** outside the VS Code webview -
`${location.protocol}//${location.hostname}:${port}` - because for a remote viewer
`localhost` names their own machine. That is the failure mode that only shows up over
the tunnel. (`SettingsModal.tsx:437` still hardcodes `ws://localhost:${port}` for its
display row; not touched here, noted below.)

**Binary guard**: everything not a directory, image or media is sniffed for a NUL byte
in its first 8 KB (git's rule) and reported as `{binary: {size}}` rather than decoded.

## Changes made

- **New** `src/backend/media.ts` - grant store (mint/lookup/sweep/evict) and range
  serving (`parseRange`, `serveMedia`), with `parseRange` exported as a pure function.
- `src/backend/filePreview.ts` - `VIDEO_EXTS`/`AUDIO_EXTS`, a `media` branch returning
  type+size and no bytes, and the binary sniff.
- `src/backend/index.ts` - the `/media/<token>` route, remote-auth gated.
- `src/backend/session.ts` - the `mediaUrl` -> `mediaGrant` handler.
- **New** `webview/src/utils/media.ts` - extension detection, origin derivation, auth
  token read, `formatBytes`.
- `webview/src/contexts/PreviewContext.tsx` - `media` and `info` frame kinds; a media
  path now asks for a grant instead of the file.
- `webview/src/components/FileViewerModal.tsx` - `MediaBody` (native controls,
  `preload="metadata"`, error fallback) and `InfoBody`; the internal navigation stack
  handles media too, so a video clicked in a directory listing behaves like a link.
- `webview/src/components/AutoFileViewer.tsx` - **rewritten to delegate** to
  `PreviewProvider`. It had been a third copy of the readFilePreview round trip, so the
  `?file=` launch param rendered a video as one blank line. Found because it was the
  entry point used for testing - it would otherwise have shipped broken.
- `webview/src/utils/fileIcon.ts` + `shared/FolderList.tsx` - `video`/`audio` kinds,
  film and note glyphs, red/green so media does not share the images' purple.
- CSP in `media/chat.html`, `media/browser.html`, `webview/index.html`.
- `webview/index.html` - `mediaUrl` added to `MOCK_SUPPRESSED`.
- **New** `e2e/media-preview.spec.ts` (mock) and `e2e/media-preview-integration.spec.ts`.

## Gotchas

- **`FileViewerModal.tsx` and its CSS module are CRLF** while most of the repo is LF, so
  an editor patch authored with `\n` matches nothing. Patched via
  `scripts/patch-fileviewer.js`, which converts its own needles and verifies each is
  unique before writing. Verified 0 bare LF afterwards.
- **`readFilePreview` is `VS_ONLY`** (`media/chat.html`), so in the extension it is
  answered by `ChatPanel`, not the daemon. `mediaUrl` must **not** be VS_ONLY: the
  process that mints a token has to be the one that serves it.
- `performance.getEntriesByType('resource').transferSize` is **0 for cross-origin**
  responses, so it cannot prove how much was downloaded. The `content-range` header from
  the network log is the real evidence.
- A pre-existing `tsc` error in `FileViewerModal.tsx` (`SyntaxHighlighter cannot be used
  as a JSX component`) is unrelated - confirmed by running `tsc` against a stashed clean
  HEAD, where it appears at the old line number.
- **`[role="dialog"]` is not unique**: the Dev Harness is one too, it is persisted in
  `localStorage`, and it sorts *first* in the DOM. A markdown regression check reported
  "does not render" against a perfectly healthy preview because the bare selector read
  the harness instead. A fresh Playwright context has empty localStorage so the harness
  is hidden and the specs would have passed today - which is what makes it a latent
  flake rather than a visible one. Scope to
  `[role="dialog"][aria-label^="File viewer"]`, as the specs now do.

## Decisions

Mine, cheap and reversible:

- ~~**No autoplay.**~~ **Overruled by the user; autoplay is now on** for both `<video>`
  and `<audio>`. Deliberately *not* paired with a muted fallback: Chrome permits unmuted
  autoplay while the document has user activation, and opening a preview is a click, so
  the normal flow starts with sound. A preview opened with no gesture at all (`?file=`
  on a cold page) is blocked by that policy and sits paused behind its controls, which
  is exactly the previous behaviour - a silent concert clip would be a worse answer than
  a visible play button.
  - **Not verifiable in the test harness, and the harness lies about it.** Playwright
    launches chromium with `--autoplay-policy=no-user-gesture-required`; probed directly
    (a detached element, no gesture, `play()` resolved) rather than assumed. So the spec
    asserts the **attribute**, never that playback started - the latter would be a test
    of the flag. `navigator.getAutoplayPolicy` is not exposed in that build either, so
    there is no cheap in-page way to tell the two apart.
  - Separately: during automation the video stalls around tool calls while playing fine
    for seconds between them, with **no `pause` event from the element** and the node
    stable and connected. Nothing implicates the app, and it did not reproduce as an
    app behaviour - recorded here so the next person does not re-chase it.
- **Native controls, not custom chrome.** Play/pause, scrub, volume, fullscreen, PiP and
  speed all arrive for free and behave as expected. Custom controls would be a large
  surface to get wrong for no gain.
- **`.mkv`/`.avi` are listed as video** even though Chrome often cannot decode them. The
  player's own error is a better message than a pre-emptive refusal, and it is what
  criterion 5 renders.
- **Red for video, green for audio** in listings rather than reusing the images' purple:
  a stories folder is wall-to-wall `.mp4` beside a `frames/` folder of `.jpg`, and one
  media colour leaves them distinguishable only by a 15 px glyph.
- **Black behind the video**, not the panel background - letterbox bars around a portrait
  clip otherwise read as part of the picture.

The user's, asked before implementing: audio included; grant-token scheme (A) over
`?path=`+nonce; non-media binaries guarded in the same change; both hosts supported.

## Verification status

Done by hand against the running dev server, in the browser, on the real reported file:
criteria 1-6 plus the binary guard and its control, and all 22 checks in
`probe-media-grant.js`, 4 in `probe-media-auth.js`, 15 `parseRange` cases against the
compiled bundle.

**The e2e suite is green**: `534 passed, 4 skipped, 0 failed, 0 flaky` in 10.4 min
(`EXIT=0`), after the timeout/retry fixes below. The four skips are the documented set
(3 AskUserQuestion specs that models decline in `--print` mode, 1 live-usage-API spec
that skips on 429). **Zero retries were consumed** - the timeout headroom alone made the
four failures pass first try, so `retries: 1` sits unused as a safety net rather than a
crutch. All four originally-failing specs confirmed in the full run: `context-window:103`
6.3s, `media-preview:271` 493ms, `session-browse:76` 7.9s, `shared-channel:257` 2.9s.

### Why they failed, and the config fix

Three of the four had **no per-test timeout override**, so they sat on the flat 30s cap
while a real turn here costs 5-20s (a fresh session starts at ~64k input tokens because
`CLAUDE.md` is 251KB and is re-read on every CLI spawn). Under full-suite load a
different one tipped over 30s each run - exactly the pattern the repo's own notes warn
reads like a regression. The "flat 30s for every project" was already fiction: nine
integration specs override it (90s/120s). Fixes, all config-level:

- `playwright.config.ts`: integration project timeout `30s -> 60s`, `retries: 0 -> 1`.
  The 90s/120s per-test overrides still win where a spec genuinely needs more; `stop-no-
  placeholder` ran 34.3s this time and would have failed at the old flat 30s.
- `context-window-integration.spec.ts:114`: the internal `toBeVisible({ timeout: 25_000
  })` cap `-> 45_000`. An assertion cap is the one budget no config setting reaches, and
  it was the line that actually timed out (the whole test ran 23.0s against it).

The bigger lever - not re-reading 251KB `CLAUDE.md` per test turn - was left alone: it
is per-file work (some specs legitimately need the real repo as workspace), not a switch,
and this change adds a paragraph to `CLAUDE.md` rather than removing one.

The earlier run that found the media defects below was `524 passed, 4 failed, 2 flaky`.

### What the suite found that hand-testing did not

**1. The failure card lied about every failure** (product). It blamed the codec
unconditionally, but a media element reports a **404 with the same `MediaError` code**
as an undecodable container. Grants live in this process's memory and the daemon
idle-exits after ten minutes, so "the link expired" is the *common* failure - and
"the browser has no decoder for this container or codec" sends the viewer off to find a
converter for a file that was never broken. `diagnoseMediaFailure()` now HEAD-probes the
server and branches on the status (404 expired / 401 signed out / other refusal / 200 ->
genuinely undecodable). Found because the mock spec injected a token no server had
minted, so the element 404'd *for real* and the card said the wrong thing.

**2. That probe was blocked cross-origin** (product, found by the integration spec the
mock one could not have found). Under Vite the page is `:5173` and the server `:3001`,
and `/media/` sent no CORS headers, so the `fetch` threw and **every** failure came back
as "the server could not be reached" - against a file the server had just served
happily. `/media/` now sends `corsHeaders(req)` on **HEAD only** (script learns the
status, never the bytes), and crucially on the **401 and 404 branches too**: a status a
script cannot read is no better than no status, and 404 is the case the feature exists
for. The VS Code webview also needed `connect-src http://localhost:*` for the probe.

A third, my own: the binary-card mock test injected a `filePreview` reply while
`readFilePreview` is **not** mock-suppressed, so it raced the live backend's `ENOENT`.
It won at first and lost once timings shifted - green until it was load-bearing. No
other spec injects a `filePreview`, which was the tell; it now uses real fixture files.

### The four integration failures, attributed

| Test | Full suite | HEAD, isolated | Mine, isolated | Mine ×3 |
|---|---|---|---|---|
| `media-preview:271` | fail | n/a | **fixed** | 4/4 pass |
| `context-window:103` | fail | pass | fail | **3/3 pass** (23.0s, 7.2s, 6.8s) |
| `session-browse:76` | fail | pass | pass | - |
| `shared-channel:257` | fail | pass | pass | - |

Only the first was mine. The other three were checked by `git stash`ing the change,
rebuilding at HEAD and re-running - **not** waved off as "known flaky", since the repo's
own notes warn that reads exactly like a regression. `context-window:103` then failed
once *with* the change in isolation, which looked damning until it was repeated: the
whole spec runs in 23.0s against a 25s cap on that one locator, and 3/3 repeats pass.
That is the documented turn-cost pattern (a fresh session here starts at ~77k input
tokens because `CLAUDE.md` is 193KB), not a regression. The other two failed only under
full-suite load with bare `Test timeout of 30000ms exceeded`.

Two mock tests (`account-usage`, `usage-indicator`) were reported flaky and both retried
green; both are usage-API specs, unrelated to this change.

Artifacts preserved in `test-results/` beside these notes, since Playwright wipes that
directory at the start of every run.

**Still not claimable:**

- **The VS Code extension host has not been exercised.** The daemon serving this machine
  (pid 17116) runs `local.argus-0.0.100\out\backend\daemon.js` - the *installed*
  extension, not this repo - so it has no `/media` route, and the session writing these
  notes is a child of it. Verifying the extension means installing this build and
  restarting that daemon via the detached target-first swap
  (`!notes/common/backend-restart.md`). Until then the `chat.html` `media-src` line is
  reasoned, not observed.

## Follow-ups

- `SettingsModal.tsx:437` builds its displayed WS address as `ws://localhost:${port}`,
  which is wrong for a remote viewer in the same way the media URL would have been.
  Cosmetic (a display row), deliberately not touched here.
- A very large **text** file still crosses the wire whole; only binaries are guarded.
  Same defect class, different trigger.
- `stringifyToolResult` has no media marker equivalent to `imageMarker`, so if a tool
  ever returns media inline it would still be stringified.
