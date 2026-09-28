# A live daemon that lost its discovery file is unreachable forever

| | |
|---|---|
| Reported | 2026-09-27, screenshot of the panel stuck on "Starting Argus daemon..." plus the "failed to start automatically" toast |
| Produced by | Claude Code, model claude-opus-5 |
| Status | Fixed, verified red then green; the live machine was unblocked by hand first |

## Symptom

The panel sits on "Starting Argus daemon...". The error toast appears: *Argus daemon
failed to start automatically. See the "Argus Daemon" output channel for details.*
Retry does nothing. It does not recover across a VS Code restart.

## What was actually wrong

A **healthy daemon was running the whole time**:

```
pid 17368, "Code.exe ...\local.argus-0.0.103\out\backend\daemon.js", started 26.09 03:12:21
listening on 37071, GET /health -> {"configPath":"C:\\Users\\Admin\\.claude\\argus.json","pid":17368}
```

What was missing was `~/.claude/argus-daemon.json`. `argus.json` has
`daemonPort: 37071`, so the port the extension would hand a replacement was the port the
incumbent held.

Reproduced directly, and the daemon printed the message written for exactly this case:

```
[argus-daemon] port 37071 already in use; no discovery file registers it - the holder is
unreachable (its nonce is memory-only), kill that process or change daemonPort. Exiting.
```

## Why it was permanent

Four facts have to hold at once, and they did:

1. The extension reads no file, so `ensureDaemon()` spawns a replacement.
2. The replacement reads `daemonPort: 37071`, hits `EADDRINUSE` against the incumbent,
   and exits 1. `FORCE_START` is false on this path, so there is not even a retry.
3. The incumbent wrote its discovery file **once, at startup**, and never again.
4. The nonce exists only in the incumbent's memory, so the file cannot be rebuilt from
   outside. `/health` deliberately returns `{configPath, pid}` and nothing else.

`spawnDaemon`'s 2s exit watch resets the debounce, so this loops once per reconnect
until `consecutiveFailures` reaches 3 and the toast fires. Nothing in the loop can ever
change its own inputs.

## This was predicted, in this repo, by the fix before it

[stale-daemon-pid/notes.md](../stale-daemon-pid/notes.md) names it while explaining why
a probe timeout is `busy` rather than `down`:

> ...would discard the discovery file of a daemon that owns the port; its replacement
> then exits on `EADDRINUSE`, leaving no file and no nonce - a permanent strand,
> **worse** than the bug being fixed.

That guard covers the one path where the *probe* decides. It does not cover the paths
that delete the file for other reasons, and it cannot: **deleting the file does not free
the port**, so "discard and respawn" is only sound when the process is genuinely gone.

## Who can delete a live daemon's file

Which one fired here is **not established**. The daemon is spawned with `stdio: 'ignore'`
and the output channel does not survive the session, so no evidence remains. Three paths
were each capable of it before this change:

| path | how |
|---|---|
| `scripts/daemon-stop.js` | ended in an unconditional `unlinkSync`, reached even when the kill threw; its local `probe()` also resolved a timeout to "not serving", so a stalled daemon read as dead |
| `extension.ts` `restartDaemon()` | `clearDaemonInfo()` with no pid (not ownership-aware), and it only killed the incumbent when `ours` was true |
| `extension.ts` `ensureDaemon()` / `verifyDaemonUp()` | clear on `!isDaemonUp`, then spawn, which then dies on `EADDRINUSE` |

A hand deletion or a virus scanner does it just as well, which is why the fix is not
"audit the callers".

## Fix

**The daemon re-asserts its own registration on a timer.** It is the only party that
knows the nonce, so it is the only one that can.

- `src/backend/daemon.ts` - the startup registration is kept in `registration`, and
  `healRegistration()` runs every `REGISTRATION_HEAL_MS` (10s, `ARGUS_DAEMON_HEAL_MS`
  overrides it for e2e) on an `unref`'d interval, so it never holds the process past its
  idle shutdown.
- It rewrites **only when the file is missing or unreadable**. A file naming a different
  pid means another daemon registered itself, and overwriting that strands *it* the same
  way; in that case we are the redundant process, not the authority. `handingOff` and
  `shuttingDown` are excluded for the same reason.
- The `EADDRINUSE` branch now probes the port before advising. The old text told the user
  to kill the holder, which for one of our own daemons means killing a healthy server
  whose registration is about to come back on its own. It now distinguishes "another
  program holds this port, change `daemonPort`" from "an Argus daemon holds it with no
  discovery file, retry shortly".
- `src/frontend/extension.ts` - `restartDaemon()`'s clear is ownership-aware
  (`clearDaemonInfo(info.pid)`), so it cannot delete a registration written between the
  read and the clear.
- `scripts/daemon-stop.js` - rewritten around one rule: never remove the file of a daemon
  that is still alive. Its probe now distinguishes `busy` from `down` the way
  `probeDaemon` does; a `busy` port leaves both process and file alone and exits 1; a
  failed kill leaves the file; a successful kill is **verified** (`waitGone`, up to 3s)
  before the file goes. Also honours `ARGUS_DAEMON_FILE`, which makes it testable and
  matches `daemonInfo.ts`.

The busy/down rule is duplicated in that script rather than imported on purpose:
`yarn daemon:stop` has to work before anything is compiled, so it stays dependency-free.

## Verification

Immediate unblock on the live machine, in this order:

1. Confirmed the incumbent was ours and idle: `/health` returned pid 17368, **0
   established connections**, one child CLI last active 26.09 03:12 (over a day idle, so
   no turn to poison - see [no-response-requested](../no-response-requested/notes.md)).
2. Checked today's two `claude.exe` were **not** under it (parents 10432 / 6764), then
   killed three explicit pids rather than using `taskkill /T`.
3. Started a fresh daemon from the same install: pid 10716, port 37071, version 0.0.103,
   file written, `/health` answering.

e2e:

- `e2e/daemon-registration-heal-integration.spec.ts` - a deleted file is rewritten with
  the **same** port/nonce/pid (a new nonce would lock out every connected client as
  thoroughly as the missing file did); a launch after the restore exits 0 instead of
  dying on `EADDRINUSE`, which is the reported failure stated as a property. Control: a
  file naming another daemon is left untouched, without which a build that rewrote on
  every tick would pass both.
- `e2e/daemon-stop-safety.spec.ts` (mock) - a stalled daemon keeps its file and the
  script exits non-zero. Controls: a genuinely stale file is still cleaned up, and a
  daemon that answers is still stopped and its file removed, so "never delete anything"
  cannot pass.

Verified red by neutralising `healRegistration()` in the compiled bundle: the heal test
and the `EADDRINUSE` test both fail, then pass again after `yarn compile`. Note the
`EADDRINUSE` test goes red at the heal-wait line rather than at its exit-code assertion,
so it is a statement of the consequence rather than an independent second witness.

## Residual

- The heal bounds the outage at `REGISTRATION_HEAL_MS` rather than eliminating it. A
  replacement spawned inside that window still exits 1; the next reconnect succeeds.
- A file naming a **dead** daemon while a live one holds the config port is still a
  strand: the heal declines to touch a file that parses, and the extension clears it and
  respawns into `EADDRINUSE`. Not observed, and it needs the registration to be replaced
  rather than deleted. The observation that would settle whether it is reachable in
  practice: a `daemonPort` change applied while an old daemon is still on the old port.
- `yarn lint` could not be run to confirm style (`eslint` is not installed in this
  environment); `yarn compile` is clean.
