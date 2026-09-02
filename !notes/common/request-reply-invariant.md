# One request, one reply (and the promise that swore it always resolves)

Every `ws` message handler in `src/backend/session.ts` is a request/reply pair: the client
posts `getX` and waits for an `x` frame. A handler that can finish **without sending
anything** turns a backend failure into a client that waits forever, and the client cannot
tell that from a slow network.

## The invariant

**Answer every request exactly once, including when the work failed.** `getUsageLimits` and
`getUsageInsights` already do this - they send an empty payload plus a string `error` rather
than staying silent, which is what lets the UI say *why* it has nothing instead of spinning.

`getAccountUsage` did not. Both of its branches ended in `.catch(() => {})`:

```ts
accountP.then(...).catch(() => {});                 // phase 1: account
Promise.all([accountP, usageP]).then(...).catch(() => {});   // phase 2: account + usage
```

A rejection therefore produced **zero frames**. In the UI that is the Account & Usage modal
stuck on "Loading..." forever with no reason shown; in a test it is
`no accountUsage frame within 20000ms`. The fix is to make the failure path send a settled
frame carrying the reason.

## `execFile`/`spawn` throw synchronously, and that rejects the promise around them

`fetchAccountInfo()` is documented as resolving `{ loggedIn: false }` on any error, and its
executor only ever calls `resolve`. It could still reject, because **`execFile` throws
synchronously when the OS refuses a new process** (`spawn UNKNOWN`, errno -4094) - a
different path from the callback's `err` argument. A throw inside a `new Promise` executor
rejects that promise, so the "always resolves" contract silently did not hold.

`handleSend` already guards `spawn()` for this exact reason (`session.ts`, "spawn() throws
synchronously when the OS refuses a new process"). Anything that starts a process needs the
same treatment:

```ts
return new Promise((resolve) => {
  try {
    execFile(bin, args, opts, (err, stdout) => { /* ... */ });
  } catch {
    resolve(fallback);        // the OS refused the spawn; still answer
  }
});
```

Grep for `execFile(`, `execFileSync(` and `spawn(` when auditing: the async error handler
next to them is not the whole story.

## Verifying it

The mechanism is testable without waiting for load. Patch `child_process.execFile` to throw
synchronously and call the real function -
[../tasks/dir-preview/scripts/probe-spawn-throw.js](../tasks/dir-preview/scripts/probe-spawn-throw.js)
does this, printing `REJECTED -> spawn UNKNOWN` before the guard and
`RESOLVED -> {"loggedIn":false}` after.

**The probe must run against the compiled bundle** (`out/backend/*.js`): emitted CJS calls
`child_process_1.execFile(...)` as a live property lookup, so it can be replaced. Under
ESM/tsx the import is bound, the patch silently does nothing, and the probe calls the real
binary and reports a green that means nothing. That happened on the first attempt.

## What this did *not* explain

Fixing the above did **not** stop
`usage-indicator-integration.spec.ts:105` from failing intermittently in full-suite runs
with the same `no accountUsage frame within 20000ms`. Measured afterwards: the handler emits
exactly two frames in ~520-630ms, 8/8 attempts, idle and while the box churns 12 concurrent
process spawns, including while the API is 429ing. Spawn latency was the third hypothesis
and it is refuted. The cause is still unknown, and the error message cannot distinguish
which of the two waits expired - see
[../tasks/usage-limits-indicator/notes.md](../tasks/usage-limits-indicator/notes.md).

The guard is worth keeping regardless: that path really did leave the modal spinning
forever. But it is an example of a fix that is correct and still not the fix.
