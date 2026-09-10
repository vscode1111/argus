# Telling whether a CLI session is working right now

Three signals look like they answer "is this session busy?" and only one of them does.
Measured 2026-09-10/11 while building the process panel's **Running** column.

## Transcript mtime does NOT answer it

The obvious implementation - "the transcript was written seconds ago, so the session is
working" - is wrong, and one measurement kills it:

> Sampled every 250 ms for 10 s against a session that was **actively mid-turn**:
> **zero writes**. Its mtime aged from 4.2 s to 29.9 s old while it was demonstrably busy.

The CLI writes at **message boundaries**, not continuously, so during a long tool call or a
long think it writes nothing at all. A freshness threshold therefore reports a working
session as idle - a false negative on exactly the row such a column exists for. Widening the
threshold does not rescue it: a session that finished 30 s ago then reads as busy.

What mtime *is* good for is **last activity**, which is all it ever honestly claimed, and it
has a real advantage there: it works for **any** session id, including one belonging to
another server, because it is a file on disk. `sessionLastActivity()` in `sessions.ts`
resolves it (path cached per id - the probe walks all ~488 project folders; a miss is
re-probed after 30 s, since a brand-new session has no file for its first seconds).

## CPU% does not answer it either

Idle CLIs measured 0.0-1.1%; the one that was working measured 1.6-2.6%. The ranges
**overlap**, so any threshold mislabels in both directions. Not used.

## Only the server's own registry knows

An entry is mid-turn when `currentProc && !cliDone` - the same test `listActiveSessions()`
uses for the Session History running dot. That is authoritative, and it is available for
exactly the processes this server spawned.

For anything else the honest answer is **unknown**, not "no". `sessionRunning` is therefore
`boolean | null`, rendered `-`, never `no`: nothing observable from outside a CLI separates
one waiting for input from one working. In normal use this is not a gap, because the daemon
serves every panel and so owns every row; the `-` only appears when a *dev server* panel
looks at the daemon's CLIs.

## Check all three states against ground truth before shipping

The first live check of the column showed `no` on our own row and could easily have been
accepted ("foreign is `-`, ours is `no`, looks right") - but the turn had simply ended
before the modal opened, so the `yes` branch had never once been observed. Pin a turn open
with a foreground `sleep 30` (turn *duration* is model-owned, so a long generation prompt is
not reliable), then confirm `yes` while the Stop button proves the turn is still live, `no`
on the same process once it finishes, and `-` on a foreign one.

## Related

- [cli-turn-boundaries.md](cli-turn-boundaries.md) - which `result` ends the user's turn.
- [../tasks/cli-process-list/notes.md](../tasks/cli-process-list/notes.md) - the panel this was built for.
