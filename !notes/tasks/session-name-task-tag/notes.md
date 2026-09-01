# Task tag in session name

**Status:** investigation only, nothing implemented
**Goal:** prefix the session title with the task short name (CON-45, B2BADM-7281, `empty-1s-turn`) so Session History is scannable.

## Where the title comes from

The title is **not** Argus's. The Claude CLI writes an `ai-title` record into the transcript
after the first turn. Argus only reads it (`readSessionMeta`, `src/backend/sessions.ts:129`),
where a `custom-title` record outranks `ai-title`.

So changing the *real* name means appending a `custom-title` line, which
`renameSession` (`src/backend/sessions.ts:511`) already does append-only and
newline-safe. The official client reads the same record, so the rename shows up there too.

## Detection: measured, not guessed

Two probes over the 300 most recent real transcripts (`scripts/probe-titles.js`,
`scripts/probe-scored.js`; raw output in `probe-out.txt` / `scored-out.txt`).

### Probe 1 - naive "find ticket ids anywhere": unusable

46/300 fired, but precision was bad. "Assess josh guha satisfaction" reported
`ADR-0002, CON-42, CON-23, CON-16, CON-39, CON-33` and none was the subject.

The pollution source is **tool results**: a session that reads `!notes/tasks/INDEX.md`,
a chat log or a sibling notes file inherits every ticket id printed in that file.
`B2BADM-6212, B2BADM-6961, B2BADM-7015` recur across unrelated CCS sessions for
exactly this reason - they live in some doc the agent keeps opening.

Branch detection (`git checkout -b …`) was worse: it matched prose and returned
`1.`, `155`, `50`, `2`, `28`. Dropped.

### Probe 2 - score engagement, ignore mentions: works

Reading is not working-on. So: **`tool_result` content is never scanned.** Only

| signal | weight |
|---|---|
| ticket/slug in the **first** user prompt | 10 |
| in a later user message | 4 |
| `!notes/tasks/<slug>/` written to (Write/Edit) | 8 |
| ticket in a written file path | 6 |
| ticket in a WebFetch/WebSearch URL | 6 |
| ticket in the CLI's own `ai-title` | 5 |

Correct on every single-task session in the sample:

- "Fix token 2022 transfer fee accounting in GT Bank deposits" -> **CON-45**
- "Document and prove builder fee invariants" -> **CON-42**
- "Собрать данные по задаче B2BADM-6264" -> **B2BADM-6264**
- "Как тестировать задачу B2BADM-7281" -> **B2BADM-7281**
- "Review YouTrack issue B2BADM-6803" -> **B2BADM-6803**
- "Fix URL highlighting bug" -> **url-linkified-as-path**
- "Fix request processing delay issue" -> **empty-1s-turn**

## Known failure mode: sweep sessions

Sessions that touch many tasks get a confident but arbitrary winner:

- "Read chat history" -> CON-16 (476) with CON-42 (208) behind it
- "Assess josh guha satisfaction" -> CON-16 (238), but the right tag is
  `josh-standing-assessment` (64), the folder actually created for it

A dominance margin alone does not catch these (116 vs 14 in one case). Needs a
sweep guard: refuse to tag when notes were written for 3+ different tasks.

Also `INDEX.md` still ranks as a candidate - probe 2 appends a separator to write
paths, so `!notes/tasks/INDEX.md` matches the folder regex. Slug must reject names
with an extension.

## Coverage

23/300 transcripts produced a tag, but that denominator is misleading: most of the
300 are e2e sessions ("Reply with just OK"). Most sessions have no task and should
get no tag - the feature has to be a no-op by default, not a best guess.

## Write-safety constraints (if implemented)

1. Never overwrite a user's manual `custom-title`. Write only when none exists.
2. Do **not** mark our records with a custom field inside the CLI's transcript -
   the official client's tolerance for unknown fields is unverified. Keep the
   "we auto-titled this" flag in `argus.json` keyed by sessionId instead.
3. Write once, after `ai-title` exists, so the tag prefixes the description
   (`CON-45 · Fix token 2022 transfer fee accounting`) rather than replacing it.
4. Backfill of existing sessions must be an explicit action, never automatic.

## Open question

Prefixing is redundant where the CLI already names the ticket ("Investigate
YouTrack issue B2BADM-5850"). Detect and skip, or normalise to the prefix form.
