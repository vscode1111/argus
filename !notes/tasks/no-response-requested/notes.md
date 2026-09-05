# "No response requested." instead of an answer

| Field | Value |
|-------|-------|
| Reported | 2026-09-05, screenshot of a user message answered by `No response requested.` (20s, 751,929 in / 7 out) |
| Transcript | `C:\Users\Admin\.claude\projects\d---Projects-scub111g-people-agent\f6bdb3e5-4ec2-4a3e-b4fa-3f0e20b8ee86.jsonl` |
| Produced by | Claude Code, model claude-opus-5, chat analysis |
| Status | FIXED - stop now interrupts instead of killing; regression spec verified red then green |

## Verdict

Argus rendered the turn correctly. The **model itself** produced the four-word answer, and it
produced it because Argus had trained it to: five earlier placeholder messages carrying that exact
string were sitting in the session's own history, put there by the CLI to repair conversations
Argus had cut off mid-flight.

## The incident, line by line

| Line | Time (UTC) | What |
|------|-----------|------|
| 1854 | 19:27:57.872 | assistant finishes normally (`stop=end_turn`, out 8,553) - the message above the red box |
| 1855-1856 | 19:28:33.689/.690 | `queue-operation` enqueue + dequeue |
| 1857 | 19:28:33.698 | user: `Но с другой стороны ведь просто так она мне бы не писала` |
| 1858 | 19:28:53.772 | assistant: `No response requested.` |
| 1861 | 19:30:26.015 | user re-sends the **byte-identical** text |
| 1862+ | 19:30:48 | a real answer, 1,483 out |

Line 1858 is a genuine API response, not a UI artifact:

```json
"model": "claude-opus-5",
"requestId": "req_011CekqxmLBioffQ3XeUf9rU",
"stop_reason": "end_turn",
"usage": { "input_tokens": 2, "cache_creation_input_tokens": 1110,
           "cache_read_input_tokens": 750817, "output_tokens": 7 }
```

2 + 1110 + 750817 = **751,929**, exactly the figure in the UI, and `out: 7` is the 7 in the
screenshot. The request itself was ordinary: the previous turn's whole context became the cache
read, and the 1,110 newly cached tokens account for the previous answer (2,481 chars of Russian
plus a markdown table) and the one-line prompt. Nothing was injected, wrapped or lost.

## Where the phrase comes from

`grep -aob "No response requested" claude.exe` (CLI 2.1.195/2.1.197, see
[../../common/cli-bundle-mining.md](../../common/cli-bundle-mining.md)) lands on four offsets. The
constant sits at 219,344,982:

```js
var Zw = "(no content)",
    Dne = "No response requested.",
    xx  = "<synthetic>";
```

The emitter is at 224,810,768, inside `deserializeMessagesWithInterruptDetection` (exported next to
`loadConversationForResume` and `getResumePrompt`, so this is the resume path):

```js
let h = p.findLastIndex(y => y.type !== "system" && y.type !== "progress");
if (!n && h !== -1 && p[h].type === "user") p.splice(h + 1, 0, _E({ content: Dne }));
return { messages: p, turnInterruptionState: g, supersededToolUseIds: l };
```

**When a resumed transcript ends with a user message nobody answered, the CLI splices in a fake
assistant turn saying "No response requested." to keep the user/assistant alternation valid.** The
same function pushes `getResumePrompt()` = `"Continue from where you left off."` for an interrupted
turn - both appear in this transcript.

The official client never shows any of this. The renderer at 225,257,953 is explicit:

```js
switch (a) { case Dne: return null; ... }
```

The remaining two offsets (225,779,052 / 225,783,865) are a separate turn-state classifier prompt
that lists the phrase as a "done" marker. It emits JSON, it is not the coding system prompt, and it
is not a plausible source for a 7-token plain-text reply.

## Why the model said it

Five placeholders were already in this session before the incident:

| Line | Date | Preceded by |
|------|------|-------------|
| 834 | 08-28 | a musing, then an **edited resend** 29s later |
| 981 | 08-29 | `Continue from where you left off.` (killed mid-turn, after a `tool_use`) |
| 1273 | 08-29 | same |
| 1531 | 08-29 | an instruction, then an edited resend 15s later |
| 1787 | 09-02 | a question, then an edited resend 23s later |

All five have `"model": "<synthetic>"` and zero tokens. They are persisted in the `.jsonl`, so every
subsequent `--resume` replays them into the API context. The session has **no compaction boundary**
(`isCompactSummary` count 0), and `cache_read` of 750,817 confirms the entire history was in context.

So by 19:28 the model had five in-context examples of *user says something -> assistant answers
"No response requested."* - two of them (834, 1787) directly after a short Russian remark with no
explicit ask, which is precisely the shape of line 1857.

## Falsification

The hypothesis was attacked before being written down. Scan of **all 1,710 transcripts** on the
machine (`scripts/scan-all-sessions.js`, `scripts/dose-response.js`), counting assistant turns whose
only content is that string:

- 151 transcripts contain it; **292 are CLI placeholders**, **4 are real model output**.
- All 4 real ones occur in sessions that already contained placeholders. **Zero** occur without.

Dose-response by number of placeholders in the session:

| placeholders | sessions | of which the model emitted it itself |
|---|---|---|
| 0-4 | 142 | **0** (0.0%) |
| 5+ | 13 | **3** (23%) |

If this were context degradation at 750k, or the model composing the sentence on its own, it should
appear in some of the 142 clean sessions - many are long. It appears in none. The other three real
emissions follow `А все тогда гуд, прости, не заметил)` and `test`: messages that, like this one,
ask for nothing. The model is deciding "nothing is being asked" and then reaching for the wording it
has seen, in English, inside otherwise entirely Russian conversations.

Alternative sources ruled out: `appendSystemPrompt` is empty in `~/.claude/argus.json`; the phrase
is absent from the project's `CLAUDE.md` and `.claude/`; Argus sends no channel wrapper, and the
1,110-token cache delta leaves no room for one.

Not established: the exact probability, and whether five is a threshold or just where this sample
crosses. 3/13 is a small numerator.

## Why Argus is upstream of this

The placeholders exist because the transcript kept ending with an unanswered user message, which is
what a hard kill leaves behind: Stop, `/clear`, `newSession`, a watchdog retry, "Stop all Claude CLI
processes", a daemon restart. Three of the five here are the same user gesture - send, notice
something, stop, edit, resend.

The interactive CLI writes an interruption record instead. Across all 1,710 transcripts there are
exactly **2** genuine `[Request interrupted by user]` records, and neither came from Argus.

Consequences, in order of how much they matter:

1. **The model's context is polluted, permanently, per session.** Argus cannot clean this: the CLI
   rebuilds the conversation from the `.jsonl` itself. Only not creating them helps.
2. **Argus's replay shows them.** `loadSession` (`src/backend/sessions.ts:521`) has no filter on
   `message.model === '<synthetic>'`, so Session History renders five bubbles the official client
   hides. Cosmetic, and does not affect what the model sees.

## Is the placeholder actually sent to the model?

Yes, and this was the load-bearing assumption, so it was tested rather than argued. A session
holding exactly one placeholder was resumed and asked to *list its own prior messages verbatim*.
The phrase never appeared in the prompt. It came back anyway (`scripts/probe-visibility.js`):

```
--- model answer ---
No response requested.
OK
--- readout ---
placeholder phrase present in the answer : true
```

The CLI stores it, hides it in its own renderer, and sends it to the API as a real assistant turn.

## The fix, and the two hypotheses that died first

**Hypothesis 1 (mine, from the first write-up): interrupt instead of killing, so the turn closes
cleanly and needs no repair. DEAD.** `scripts/probe-interrupt.js` in three modes, each ending run 1
differently and then cold-resuming:

| mode | interrupt acked | turn ended | transcript ends on | placeholder after resume |
|---|---|---|---|---|
| `kill` (today) | - | - | `user(text)` | **1** |
| `interrupt` | yes, 40ms | - | `user(text)` | **1** |
| `interrupt-wait` | yes | yes, `result` in 6ms | `user(text)` | **1** |

The CLI never writes an assistant record for an interrupted `--print` turn, not even when the turn
ends properly. Interrupting does not repair the transcript. Shipping it as the fix would have been
compensating code on an untested theory.

**Hypothesis 2: repair the transcript from Argus (append a closing record, or truncate the dangling
tail). REJECTED without shipping.** Appending only renames the problem - any fixed repair string is
equally imitable, and we would be choosing the poison instead of the CLI. Truncating means mutating
a 12MB conversation history irreversibly, and a turn killed after a tool call ends on a
`type: user` tool_result whose removal would orphan its `tool_use`.

**What actually works** came out of re-reading the splice condition: it fires only when the **last**
message is a user message. So the dangling record does not have to be removed, only buried.
`scripts/probe-reuse.js`: interrupt, keep the process, send the next message down the same stdin.

```
interrupt acknowledged : true
process still alive    : true
results seen           : 2
session ids seen       : 1
transcript lines       : 17, last message = assistant(text)
placeholders           : 0
VERDICT: reuse WORKS, placeholders avoided
```

A reused process takes no `--resume`, so no rebuild happens at all; and once its answer lands after
the abandoned message, the abandoned message is no longer last, so no *later* cold resume splices
one either. Permanent, not deferred - asserted directly by the third turn of the e2e spec, which
forces a genuine `--resume` via plan mode and still counts zero.

## What shipped

| Change | File |
|---|---|
| `interruptProc()` - writes the control frame, returns false if the pipe is gone | `src/backend/cli.ts` |
| `handleStop` interrupts and keeps the process; kill only as fallback | `src/backend/session.ts` |
| `abortPendingStop()` - fall back to kill for a send that beat the ack, and for `/clear` | `src/backend/session.ts` |
| `s.stopping` / `s.stopKillTimer` | `src/backend/sessionState.ts` |
| swallow the interrupted turn's trailing events; its `result` retires the fallback | `src/backend/cliHandler.ts` |
| `isSyntheticPlaceholder()` - hide the placeholder in replay, as the official client does | `src/backend/sessions.ts` |
| regression spec | `e2e/stop-no-placeholder-integration.spec.ts` |

`s.stopping` is not optional. The interrupted process is deliberately **not** detached any more, so
without it the trailing chunks would append to a message the UI already committed, the
autonomous-turn recovery branch would read them as a background-task turn and raise a phantom
`thinking_start`, and the `is_error` result would surface a "stopped" error block.

Red/green: forcing `interruptProc` to `return false` (the old behaviour, through the new code path)
fails the spec at `Expected: 0, Received: 1`; reverted, it passes with all four assertions including
the cold resume. `stop-then-send`, `clear`, `send-while-streaming` integration specs and 39 mock
specs (`stop-no-error`, `session-history`, `background-tasks`, `task-notification-result`) stay green.

## Still open

- A session stopped and then **abandoned** - panel closed, daemon restarted, args changed before the
  next send - still ends on the dangling record, and its next cold resume splices exactly one. One
  per abandoned session instead of one per stop; the reported session would have had 0-1 instead of 5.
- `newSession` leaves the old entry's transcript dangling the same way. Not addressed: it moves the
  client to a fresh entry and the old entry may still have clients in it.
- Placeholders already in existing transcripts stay there and keep going to the model. Nothing here
  cleans them; the only remedy for a badly poisoned session is to start a new one.
- A stopped process is now **attached** where the killed one was detached, so if that CLI later dies
  on its own (a crash, "Stop all Claude CLI processes"), `attachProcHandlers`' `close` will surface
  the exit code as an error block where a stop used to swallow it. Deliberately not guarded: it is
  the same exposure a reused process has had after every normal turn, and no failing case was
  observed. The paths that matter do detach first - the fallback kill, `abortPendingStop`, `/clear` -
  and entry eviction has no clients left to show anything to.

## Scripts

| Script | Purpose |
|--------|---------|
| `scripts/dump-tail.js` | last N transcript entries, one line each, with usage |
| `scripts/dump-range.js` | same for an explicit line range |
| `scripts/dump-raw.js` | pretty-printed raw JSON for a line range |
| `scripts/find-phrase.js` | every assistant turn matching a phrase, with the preceding context |
| `scripts/extract-window.js` | latin1 window around a byte offset in the CLI binary |
| `scripts/scan-all-sessions.js` | synthetic vs real emissions across all transcripts |
| `scripts/dose-response.js` | placeholder count vs probability of a real emission |
| `scripts/find-near.js` | two strings within N bytes of each other in the CLI binary |
| `scripts/probe-interrupt.js` | `kill` / `interrupt` / `interrupt-wait`, each followed by a cold resume |
| `scripts/probe-visibility.js` | does the model see the placeholder (quote-your-own-messages) |
| `scripts/probe-reuse.js` | interrupt, then reuse the same process for the next turn |
