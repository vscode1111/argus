# slow-image-preview: clicking an image tool result took 3-5s to preview

## Problem

Reported: "When I open image-link to preview it takes 3-5 sec. It looks slowly",
with a screenshot of the FileViewerModal loading spinner over
`C:/Users/Admin/AppData/Local/Temp/avito-form2.png`, and a pointer at the session
transcript behind it:
`C:\Users\Admin\.claude\projects\d---Projects-scub111g-estate-agent\8dbb366b-44d5-4b07-bae1-ba0ae03589d8.jsonl`.

## Reproduction

The transcript is real: a Bash call (`chrome-cdp.js shot`) saved a screenshot to that
path, then a `Read` (`toolu_018B4rQCgo2PsbhZQZMeATK4`) read it back - the click in the
screenshot opens that Read's image via the `{kind:'toolImage'}` flow
(`readToolImage(sessionId, workspaceDir, toolUseId)` in `src/backend/sessions.ts`).

**Environment**: the transcript file is 335-337 MB (it was still being appended to
while this was investigated) - the estate-agent project does heavy CDP
screenshot-then-Read automation, and each screenshot is a full base64 image line.

**Expected**: near-instant (the whole point of fetching the image on demand rather
than inlining it in every replay, per
[../image-preview-from-tool-result/notes.md](../image-preview-from-tool-result/notes.md),
was sub-second - "~240 ms on the 24 MB transcript" per that task's own notes).

**Actual**, measured directly against the real file and the real function
(`scripts/probe-read-tool-image.js`):

```
size: 335.7 MB
readToolImage(): 1359 ms -> found, image/png, 78 KB base64
```

Consistent with "3-5s" reported: that number is on a warm OS file cache (the probe
script itself had just touched the file); the user's actual click was very likely a
cold first touch of a 335 MB file, plausibly slower.

## Root cause

`readToolImage()` read the **entire transcript file into memory as a decoded UTF-8
string** before searching it at all:

```ts
let content: string;
try { content = fs.readFileSync(file, 'utf8'); } catch { return null; }
for (const line of content.split(/\r?\n/)) { ... }
```

Isolating the cost (`scripts/probe-isolate-cost.js`, same file, 3 runs):

```
readFileSync(Buffer, no decode):   145-186 ms
readFileSync('utf8', decoded):    1161-1220 ms   <- the actual bottleneck
content.split(/\r?\n/):            141-253 ms
```

**The UTF-8 decode of the whole file, not disk I/O, was ~85% of the total cost.**
Raw I/O for 335 MB (warm cache) is only ~150-190ms; decoding those bytes into a JS
string costs an *additional* ~1000ms. The "cheap prefilter" comment on the original
code (`line.includes(toolUseId)` before `JSON.parse`) only ever addressed the
`JSON.parse` cost, never the cost of producing `content`/`lines` in the first place -
which happens before the prefilter runs at all, and dwarfs it.

### Toggle experiment / phase two

First candidate fix (streaming with `readline` over a UTF-8-decoded stream, early
exit on match) was built and measured **slower**, not faster - `1637-1687ms` vs the
`1359ms` baseline (`scripts/probe-streaming-fix.js`). This falsified the "just avoid
reading the whole file" framing: for this transcript the match sits at line 3687 of
3767 (97.9% through), so early exit barely helps, and `readline`'s per-line-event
streaming still decodes the *entire* file to UTF-8 (in smaller chunks) while adding
event overhead on top - worse on both counts.

The isolation probe above is what actually located the cost (decode, not I/O), which
pointed at the real fix: read as a raw `Buffer` (no whole-file decode at all), search
for the id at the **byte level** (`Buffer.indexOf` with an ASCII needle - `toolUseId`
is already ASCII-only per `TOOL_USE_ID_RE`), and decode **only the matched line**
to a string before `JSON.parse`. Verified against the same real file
(`scripts/probe-buffer-fix.js`): **322-427ms**, and a byte-for-byte (`sha256`)
comparison against the original's output confirmed identical results
(`scripts/compare-outputs.js`).

## Fix

`src/backend/sessions.ts`: extracted the scan into `scanTranscriptForImage(file,
toolUseId)` (exported, so a test can drive it against an arbitrary file without a
real `~/.claude/projects` entry), and rewrote it to scan the raw buffer at the byte
level instead of decoding the whole file up front. `readToolImage()` keeps its exact
original signature and behavior (id validation, path resolution, existsSync guard),
now delegating the scan to the new function. No caller changes needed - the function
stayed synchronous.

Scanning for newline bytes (`0x0a`) at the byte level is safe in UTF-8: any byte
below `0x80` can only ever be a genuine ASCII character (continuation and leading
bytes of multi-byte sequences are always `>= 0x80`), so a raw `0x0a` byte can only be
a real line break, and slicing on those offsets can never split a multi-byte
character mid-way.

**Measured on the real reported transcript, after the fix**: `readToolImage(): 179ms`
(down from 1359ms at the start of the investigation; the file had grown slightly in
the meantime, to 337.5 MB, from continued use).

### Siblings found, not fixed

Two other functions in the same file share the identical pre-fix pattern
(`fs.readFileSync(file, 'utf8')` then `content.split(/\r?\n/)`), found by grepping the
file. Neither is a trivial, identical fix like `readToolImage` was:

- **`loadSession()`** (opens/resumes a session's full transcript) - measured
  **1184-1679ms** on this same 335+ MB transcript across several runs
  (`scripts/probe-sibling-costs.js`). Unlike `readToolImage`, it must process
  **every** line (building the full replayed message list), so it has no
  early-exit to benefit from - the same "buffer, decode only what's needed" trick
  does not directly apply, since everything is needed. A real fix there (e.g.
  decoding line-by-line off the buffer instead of the whole file at once) is a
  plausible follow-up but needs its own measurement to know whether it actually
  helps, and touches a much larger, more complex function.
- **`readSessionMeta()`** (per-session metadata for Session History listing) - not
  benchmarked in isolation, but it is called once per session by `listSessions()`,
  which measured **3285ms** for this one workspace (24 sessions, one of which is the
  335+ MB transcript) - worse than the reported bug. Same "must read every line"
  constraint as `loadSession`.

**Not fixed here** - out of scope for "the image click is slow" as reported, and
per the skill's own instruction not to widen a fix beyond identical/trivial
siblings without asking first. Flagging for a decision: fixing these needs its own
investigation (whether a line-by-line buffer scan, rather than one big
`readFileSync(file,'utf8')`, actually helps when *every* line must be decoded
anyway - not obviously true the way it was for the early-exit case), and touches
higher-traffic, more complex code (`loadSession` is what runs on every session open;
`listSessions` runs on every Session History open for this workspace).

## Verification

**Before/after on the real reported transcript** (same file, same tool_use_id, same
function):

| | before | after |
|---|---|---|
| `readToolImage()` | 1359 ms | 179-327 ms (several runs) |

**Pinned test**: `e2e/tool-image-large-transcript.spec.ts` (mock, no browser needed -
drives the compiled `sessions.js` directly). Generates a synthetic ~100 MB fixture
shaped like the real transcript (big base64 "screenshot" lines, some Cyrillic prose
mixed in, target near the very end - the reported worst case), asserts the found
image is byte-length-correct and the scan completes under a threshold (250ms)
calibrated between the pre-fix (362-523ms measured on this fixture) and post-fix
(73-120ms measured) ranges - wide margin on both sides for CI variance. A second test
covers the no-match case (a `toolu_...` id that never occurs) staying fast too, so a
build that fell back to a full scan-every-line-on-miss doesn't sneak back in.
**Verified red first**: the fix was reverted, the test failed on the time assertion
specifically (292ms / 360ms received vs 250ms expected) - not a missing-export or
structural failure - then the fix was restored and reconfirmed green (10/10 across
5 repeats under parallel load).

**Gates**: `npx tsc -p ./ --noEmit` clean. `e2e/tool-image-preview.spec.ts` (mock) and
`e2e/tool-image-preview-integration.spec.ts` (real CLI) both pass - the existing
correctness coverage for this feature (never re-reads the file, opens with a spinner,
survives the file being deleted) is unaffected, since the fix only changes *how* the
transcript is scanned, not the contract.

**Full suite**: `npx playwright test` (mock + integration): 513 passed, 5 failed, 1
flaky (passed on retry), 6 skipped, 17.4 minutes - a run under noticeably heavier
system load than a same-day earlier run of the same suite (10 minutes). All 5
failures investigated individually, not assumed benign:
`clear-integration.spec.ts`, both failures in `slash-commands-integration.spec.ts`,
and `stop-daemon-integration.spec.ts` are in areas this fix never touches (session
`/clear`, the slash-command menu, the daemon-stop button) and all cleared with
comfortable margin in the immediately-preceding tests of the same files, consistent
with individual timeouts under load rather than a shared cause.
`tool-image-preview-integration.spec.ts` **is** in this fix's own area and got a full
investigation, not a pass - see Gotchas: it failed with the exact ENOENT-fallback
symptom of a pre-existing, already-documented race, reproduced specifically during
the heaviest part of this run, and passed clean 12/12 on immediate re-runs under
normal load.

**Hands-on**: dev server pointed at the real `estate-agent` workspace, deep-linked to
the exact reported session (`?dir=...&session=8dbb366b-...`), found the same `Read`
row the screenshot showed (`C:/Users/Admin/AppData/Local/Temp/avito-form2.png`) and
clicked it. The Avito form screenshot ("Способ связи") was already fully rendered -
no lingering spinner - by the time the very next screenshot tool call captured the
page, which is well under a second of wall-clock time; with the pre-fix ~1.3s+
behavior, that same screenshot would have caught the loading spinner instead. Console
showed 8 pre-existing React "duplicate key" warnings for two `toolu_...` ids in
`ChatMessage.tsx`, unrelated to this fix (only `sessions.ts` was touched) - noted as
an aside, not chased down here.

## Files changed

- `src/backend/sessions.ts` - `readToolImage()` / new `scanTranscriptForImage()`.
- `e2e/tool-image-large-transcript.spec.ts` (new) - the pinned regression test.

## Gotchas

- A Windows Defender / Playwright browser-extraction issue unrelated to this bug
  (documented in `.claude/researches/playwright-install-hang.md`) wiped this
  machine's `ms-playwright` chromium install mid-session; `yarn test:e2e:install`
  (the repo's own documented manual installer) was needed to get the mock/integration
  suites running again for verification.
- The streaming/`readline` candidate looking *slower* than the naive baseline is the
  most useful gotcha here: "avoid reading the whole file" was the wrong mental model
  for a file where the match sits at 98% through it - the actual win came from
  avoiding the UTF-8 *decode*, not from avoiding the *read*, and those are separable
  costs that isolating them (Buffer vs 'utf8' timing) made obvious in a way that
  "streaming feels like it should help" did not.
- **`e2e/tool-image-preview-integration.spec.ts` failed once, during full-suite
  verification, with the exact ENOENT-fallback symptom the feature's own original bug
  report described** - not treated as "probably fine" without checking. This
  specific test's failure mode (the transcript lookup finds nothing, so the code
  falls back to reading the now-deleted file from disk) is a pre-existing, already
  documented race, independent of this fix:
  [../image-preview-from-tool-result/notes.md](../image-preview-from-tool-result/notes.md)'s
  "Open: the transcript lookup can miss data that is on disk (2026-09-03)" section
  describes the identical symptom, dated well before this task, with two unconfirmed
  suspects (a session-id mismatch under load, or a flush race between the CLI writing
  the tool_result line and Argus reading it). It reproduced here specifically **during
  and immediately after** a 17.4-minute full-suite run under heavy load - confirmed
  independently, since even a bare `wc -l` on a local log file was timing out at
  15-120s in that same window, evidence of genuine system-wide resource contention,
  not application logic. Re-run 12/12 clean afterward under normal load
  (`--repeat-each=4` then `--repeat-each=8`, both 100%). Considered whether the fix
  itself could make the race more likely - it does not: the read is triggered at the
  same moment (the click), the fix only shortens how long that read takes once
  started, which does not move the race window earlier. Not fixed here - it is a
  pre-existing, separately-scoped issue; flagging it again (with a second, independent
  reproduction and load correlation) rather than silently re-closing it.

## Decisions

- Kept `readToolImage()`'s signature synchronous rather than converting to async
  (the streaming candidate would have required this) - the buffer approach reaches
  the same or better speed with zero ripple to the one caller in `session.ts`.
- Left `loadSession`/`readSessionMeta` alone rather than silently applying the same
  fix - they do not have the same "early exit on one match" shape that made this fix
  both correct and clearly faster, so extending it there needs its own measurement,
  not an assumption that "the same trick will work".

## Related tickets

None (reported directly, no tracker reference).
