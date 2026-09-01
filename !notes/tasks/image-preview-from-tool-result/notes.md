# Image previews come from the tool result, not from the file on disk

| | |
|---|---|
| Reported | 2026-09-01, screenshot of session `7ac16cc8-59bd-4540-ba46-f4b9a50f2815` (`d:\_Projects\scub111g\estate-agent`) at `localhost:5173` |
| Produced by | Claude Code, model claude-opus-5 |
| Status | Fixed, tests green (mock + integration), not committed |

## Symptom

Clicking an image the agent had read opened the file viewer showing
`Error reading file: ENOENT: no such file or directory, open 'd:\_Projects\...\out\согласие\p2.jpg\Согласие на дарение Бискуб Н.М. 2.jpg'`
as line 1 of a text file. User: "I can't see the content of that image."

## What it was NOT

Not the file-path linkifier (the previous task,
[url-linkified-as-path/](../url-linkified-as-path/), had just fixed a mis-linkified URL, so
that was the natural first suspicion). The model really did pass that path: `image-tools
scan` writes into a folder named after the input, `out/согласие/p2.jpg/<name>.jpg`. The
Read **succeeded** at the time and returned a 174 KB JPEG (transcript tool call
`toolu_012aMVJaRisb1uw7eWpjaryf`). Later in the same session the agent ran
`mv "$OUT/p2.jpg/…" "$OUT/Согласие 2.jpg"` and deleted the temp folders. The ENOENT was
factually correct.

## Root cause

Argus rebuilt every image preview by **re-reading the path off disk** (`ToolCall` opened a
`{kind:'path'}` request, resolved by `readFilePreview`), and ignored the image the tool had
actually returned - which was in the message the whole time.

Two consequences, one visible and one not:

1. Any image whose file has since been renamed, packaged or deleted cannot be previewed,
   even though the bytes the model saw are in the transcript. Temp and processed files are
   exactly the ones the agent moves.
2. Those bytes were shipped to the client anyway and never rendered. Measured on the
   reported session (`scripts/probe-replay.js`): 66 Read calls, 48 carrying a full base64
   image inside `call.result`, **23.4 MB of a 24.2 MB `sessionLoaded` payload**, resent on
   every replay and reconnect. `ws` 8.20.0 defaults `perMessageDeflate` to false and
   `src/backend/index.ts` passes no override, so it crosses the wire raw - and base64 of
   JPEG barely deflates anyway. The user runs Argus over the internet, which is what
   settled the design.

## Fix

Strip at the boundary, fetch by id on demand.

- `src/backend/toolResult.ts` (new): `stringifyToolResult()` flattens a tool result and
  replaces base64 image blocks with `[image image/jpeg 174 KB]`. Used by both paths that
  feed the webview - live (`cliHandler.handleUserEvent`, `handleToolResult`) and replay
  (`sessions.loadSession`). `handleToolResult` also stopped passing a raw block array as
  `result`, which the webview treats as a string (it calls `.trim()` on it).
- `sessions.readToolImage(sessionId, workspaceDir, toolUseId)`: finds the transcript line
  for that tool call and returns the base64. Cheap `line.includes(id)` prefilter before
  `JSON.parse` (transcripts run to tens of MB); id is regex-validated; reuses
  `resolveSessionFile`'s UUID + traversal guards. ~240 ms on the 24 MB transcript.
- `session.ts` answers `readToolImage {toolUseId, path}` with `toolImage {toolUseId, path,
  content}`. The session is resolved server-side as
  `channel.getViewingSessionId(ws) ?? s.sessionId` (new accessor), so a client browsing a
  past session reads from the transcript it is actually looking at. Falls back to
  `readFilePreview(path)` when the transcript has no image for that call - an old session,
  or a result line the CLI has not flushed yet.
- Webview: new `{kind:'toolImage'}` `PreviewRequest`, resolved in `PreviewContext` by
  posting `readToolImage` and matching the reply **on the tool call id** (exact, unlike the
  path-suffix match `filePreview` needs). `ToolCall` returns it for image files.
- `readToolImage` added to `webview/index.html`'s `MOCK_SUPPRESSED`.
- Feedback for the round trip the user now pays per click (asked for right after the fix
  landed). First shape was a small floating spinner over the app while the fetch ran, with
  the modal still deferred until the content arrived; the user's follow-up was explicit -
  **open the modal immediately and put the spinner in it**, which is also the better
  answer: the window appears on the click that asked for it and its header names the file
  being read. `open()` now pushes a frame with `loading: true` and a `loadId`, and the
  reply settles *that* frame by id, so a second preview opened meanwhile cannot be
  overwritten. Paired with a 20 s give-up - the host answers even on a failed read, so
  silence means a lost message, and an eternal spinner reads as a hang.

Result on the reported session: `sessionLoaded` **24.2 MB -> 0.8 MB**, and each image
result is a 25-character marker.

## Verification

- `scripts/probe-replay.js` - payload before/after, per-Read result kind, and which paths
  no longer exist (35 of 66).
- `scripts/probe-tool-image.js` - recovers the exact image the user could not see from the
  transcript by tool id (`image/jpeg, 128 KB, 245 ms`, JPEG magic `ffd8ff`), and returns
  null for a text Read, an unknown id, and a traversal-shaped id. `recovered.jpg` is the
  notary consent page 2 from the report.
- `e2e/tool-image-preview.spec.ts` (mock): the click asks for `readToolImage` and never
  sends `readFilePreview`; a reply for a different tool id does not open the modal; the
  right id renders the `<img>`. Control: a text Read still opens from the result it already
  has, with no request at all.
- `e2e/tool-image-preview-integration.spec.ts` (real CLI): the agent reads a PNG, **no WS
  frame carries inlined base64** and the marker is present, then the file is **deleted**
  and the click still renders the image. Deleting it is what makes it decisive - the disk
  fallback is still in place, so a build that only re-read the path fails here exactly as
  the user's did.
- Both red-verified by mutating the new code back to the old behaviour (the fix creates the
  path under test, so reverting would red for the wrong reason): the webview mutation left
  `suppressed: []`, the backend mutation produced one frame carrying the whole base64,
  named in the failure output.
- `e2e/modal-persistence.spec.ts`'s image case now injects the reply (its round trip moved
  to the integration spec); the file-path-link case still exercises the real
  `readFilePreview`.
- Spinner: the modal is asserted visible **with the path and no `<img>`** while the fetch
  is outstanding, and the reply replaces the spinner with the image; a reply for another
  tool id leaves it spinning. The text-Read control asserts no spinner at any point.
  Eyeballed too - `scripts/shot-spinner.js` writes `spinner.png` / `after-reply.png`
  against a live `yarn dev`.
- Full mock suite after the spinner: 254 passed, 1 failed - `model-picker.spec.ts` "a dated
  list id highlights when the active model is the dateless alias", the known
  config-dependent failure of the mock-only escape hatch (named in
  [../../common/e2e-testing.md](../../common/e2e-testing.md)); it passed in the earlier
  full run, where Playwright owned the dev server.
- Full suite before the spinner: 381 passed, 2 failed - `daemon-lifecycle` "a second launch
  exits without taking over the running daemon" and `usage-indicator` "a modal fetch
  becomes the snapshot every other client reads". **Both fail identically on a clean HEAD**
  (verified by stashing this change and re-running), so they are pre-existing; the daemon
  one is not an API flake and deserves its own look.

## Remaining work

- Not committed.
- **The user's daily Argus does not have this yet.** The daemon serving them runs from
  `~/.vscode/extensions/local.argus-0.0.89/out/backend/daemon.js` (pid 6360, port 51852),
  not from this repo, and `yarn build` writes *this* repo's `media/`. Needs the package +
  install + daemon restart dance from [../stale-daemon-deploy/notes.md](../stale-daemon-deploy/notes.md).
- Tool results are stripped on both paths, but a **pasted user image** (the `images` field
  on a user message) still travels in full, in the live message and in every replay of it.
  Same technique would apply; out of scope here.
