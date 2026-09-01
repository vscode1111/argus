# Large payloads a tool hands back

A tool result is not only text. A Read of an image returns a base64 block, and that block
is orders of magnitude larger than everything else in the conversation. The rule that came
out of [tasks/image-preview-from-tool-result/](../tasks/image-preview-from-tool-result/notes.md):

**Strip it at the boundary, fetch it by id on demand.**

## What went wrong without it

- **Nothing rendered the bytes, and they shipped anyway.** The preview re-read the file off
  disk instead, so the base64 was pure freight: 23.4 MB of a 24.2 MB `sessionLoaded`
  payload on one real session, re-sent on every replay and reconnect. Measure the payload
  before deciding anything here - the number is what settles the design, especially for a
  user on a remote link, where 24 MB is ~40 s of staring at a spinner on a 5 Mbit/s uplink.
- **Disk and transcript are two different sources of truth, and they diverge silently.**
  The file the tool read gets renamed, packaged or deleted minutes later; the transcript
  keeps what the model actually saw. Re-reading the path is not "the same image later", it
  is a different question that happens to have the same answer most of the time. Prefer the
  transcript and keep the disk read as the fallback, not the other way round.
- **Compression will not save you.** `ws` defaults `perMessageDeflate` to false, and base64
  of an already-compressed format (JPEG, PNG) deflates by a quarter at best.

## Doing it

1. One helper, used by **every** path that feeds the client. Live streaming and replay from
   disk are separate code paths in this repo (`cliHandler` and `sessions.loadSession`);
   strip in one and the other still leaks the whole payload.
2. Leave a readable marker in place of the bytes (`[image image/jpeg 174 KB]`), not an empty
   string. It is what the tool row and the output preview now show, and it tells the reader
   the thing existed.
3. Address the payload by **the id the protocol already has** (`tool_use_id`), not by path.
   Paths move, and a reply matched on a path cannot tell two images in one turn apart.
4. Resolve the id server-side from the session the client is *looking at*
   (`getViewingSessionId(ws) ?? s.sessionId`), not the one its entry is streaming.

## Testing it

- The payload half: assert **no frame carries the payload**, with the threshold at the real
  boundary (a 1000-char base64 run is far above anything else a turn produces and far below
  one inlined image), and assert the marker is present so "nothing arrived at all" fails too.
- The retrieval half: **delete the file before the click**. The disk fallback is still
  wired, so that is the only way to prove the data came from the transcript; with the file
  in place, the old broken build passes.
- Both halves red-verify by mutating the new code back to the old behaviour, not by
  reverting (the fix creates the path under test).

Still carried in full, if this comes up again: a **pasted user image** (`images` on a user
message), in the live message and in every replay of it.
