# Local development setup

## Source files are CRLF, notes are LF - a `\n` anchor in a script silently no-ops

The working tree is mixed by convention: every `.ts`/`.tsx` under `src/` and `webview/` is
**uniform CRLF** (`webview/src/reducer.ts`: 436 CRLF of 436 newlines), while `!notes/**` and
`CLAUDE.md` are LF-only. `git status` says as much on every commit ("LF will be replaced by
CRLF the next time Git touches it") and it is easy to read past.

The consequence bites when a script edits source rather than the Edit tool:

```js
src.replace("  foo: bar,\n", "")        // matches nothing, no error, no diff
src.replace(/^\s*foo: bar,\r?\n/m, "")  // works on both
```

Measured 2026-09-07: a one-line removal in `reducer.ts` reported success and changed
nothing, and the e2e run that followed was green **because the revert had never been
applied** - i.e. a verify-red step that silently verified nothing. Anchor on `\r?\n`, or
better, use the Edit tool for source and keep scripts for the `!notes/` index rows, where
the LF assumption holds.

Corollary for `/update-notes` step 7: never run `sed -i 's/\r$//'` across "the files this
session touched" when that list includes source. A uniform-CRLF file is following the
convention, and stripping it rewrites every line.

## Backticks inside a double-quoted `node -e` are executed by bash

Same shape of failure, different layer. Editing `CLAUDE.md` through
`node -e "...the \`system\`/\`task_notification\` event..."` runs `system` and
`task_notification` as **commands**: bash performs command substitution inside double quotes,
the empty output is spliced in, and the file receives "the / event". Observed 2026-09-08; the
only visible sign was two `command not found` lines above a cheerful `applied 3 of 3`.

Prose destined for a markdown file is full of backticks, so this is not an edge case here.
Use the Edit tool for such text, or single-quote the whole `node -e` script, or write the
script to a file under the task's `scripts/`. When a script does report success, read back the
line it wrote before believing it.

## Nothing typechecks `webview/` - run it by hand

No script in this repo typechecks the webview. `yarn build` is `vite build`, which uses
esbuild: types are **stripped, never checked**. `yarn compile` is `tsc -p ./`, whose
`include` is `["src/**/*"]` - `webview/` is outside it. So a webview type error survives a
green build, a green compile, and a green e2e run; only the editor shows it.

```sh
npx tsc -p webview/tsconfig.json --noEmit
```

Worth running after any webview refactor. Two errors were sitting there undetected when this
was first run (2026-08-21):

- `FilePathLink` passing an `endLine` prop `FileViewerModal` does not declare - i.e. `:12-80`
  ranges had been silently scrolling to the start line only, with no other effect. Real bug,
  invisible to every check in CI.
- `SyntaxHighlighter` "cannot be used as a JSX component" in `FileViewerModal` - a
  React 18 / `@types/react-syntax-highlighter` version mismatch, cosmetic, still open.

Expect that second one in the output; anything else is new.

## `C:` drive full breaks `yarn install`

This dev machine's `C:` drive can run completely out of space (0 bytes free per `wmic logicaldisk get caption,freespace,size`), which fails `yarn install` with `ENOSPC: no space left on device, write` while extracting packages, even though the project itself lives on `D:` (which has hundreds of GB free). The cause is yarn's global cache, which defaults to `C:\Users\Admin\AppData\Local\Yarn\Cache` regardless of where the project sits. This is a package-manager symptom, not a project problem - it shows up as soon as `node_modules` needs a fresh install (e.g. a clean checkout, or `node_modules` never having been installed).

Workaround, without touching anything on `C:`:

```bash
mkdir -p /d/_yarn-cache-tmp
yarn install --cache-folder "D:/_yarn-cache-tmp"
```

Check free space first if `yarn install` / `yarn build` / `yarn compile` fail with `ENOSPC`:

```bash
wmic logicaldisk get caption,freespace,size
```

If `C:` is at or near 0 free, that is the root cause, not a bug in this repo's tooling.

## Background jobs started in `daemon.ts` do not run under `yarn dev`

The repo has two server entry points over one `startServer()`: the daemon (`src/backend/daemon.ts`,
fixed port, idle-exit) and the dev server (`server/index.ts`, `:3001`, what `yarn dev` runs). Anything
periodic registered in `daemon.ts` therefore exists only in the daemon, and the dev server, where the
feature is actually being developed and demoed, silently never does it.

This is not theoretical: the usage poller was written that way and the feature was reported as
missing on the dev server. It was not missing - the dev server answered every request correctly, but
with nothing refreshing in the background, the single fetch made when a client connected was the only
attempt ever made, so one transient failure left the UI empty until a manual reload. Moving the call
into `startServer()` (after `listen`) gave both processes exactly one poller, with no per-client
polling, and made the retry cadence apply where it is developed.

**Rule of thumb:** put recurring work in `startServer()` unless it is genuinely daemon-only
(discovery-file ownership, idle-exit, respawn). Then give it an env kill switch, because the e2e
suite runs the dev server too (see [e2e-testing.md](e2e-testing.md)).

**Known remaining case:** `scheduleModelDataRefresh()` is still called from `daemon.ts` only, so the
daily model-data refresh (default model, family descriptions, `/v1/models` context windows) never runs
on a machine that only ever uses `yarn dev`. Deliberate for now - it spawns a real CLI turn, so it
should not fire on every dev restart - but it means a dev-only environment keeps a stale
`modelListCache`, which is the input to the context-window percentage
([model-context-windows.md](model-context-windows.md)). `yarn update-models` refreshes it by hand.

## `yarn dev:stop` does not stop `yarn dev`

`scripts/dev-stop.js` kills whatever holds :5173 and :3001, but `scripts/dev.js` runs the
backend under `tsx watch`, and **that supervisor survives and respawns the server within
seconds** (observed 2026-09-01: `dev:stop` reported both pids stopped, and a `/health`
probe a minute later answered from a new pid whose parent was the still-running
`tsx/dist/cli.mjs watch`). The symptom is Playwright's `global-setup` guard firing on a
dev server "you already stopped", still on the real `~/.claude/argus.json`.

Kill the supervisors themselves (`tsx ... watch` and `vite/bin/vite.js` for this repo),
then re-check that neither port has a `LISTENING` socket. When matching processes by
command line, match the **executable**, not just the repo path: a pattern loose enough to
hit `scripts.dev\.js` also matches the agent's own shell processes, whose command lines
carry the cwd - that killed two live tool shells in the same run.

The mirror image bites harder: **a dev server Playwright started can outlive the run**, and
it holds `ARGUS_CONFIG=e2e/argus.json`. `global-setup` protects the tests from the user's
server, but nothing protects the user from the test server - their tab keeps working, now
against e2e settings (`appendSystemPrompt`, pinned model, `showLogs`). Observed
2026-09-01: after an integration run, a fresh `yarn dev` had its Vite die with exit 1 on
the busy port while `/health` answered `configPath: ...\e2e\argus.json`. **After any run
that stopped the user's server, finish by asserting `/health` reports
`C:\Users\Admin\.claude\argus.json`** - "the ports are listening again" is not the check,
the config path is. `env -u ARGUS_CONFIG yarn dev` keeps an exported var out of it too.

## Stuck loading spinner after restarting `yarn dev`

A browser tab left open from a previous `yarn dev` process can get stuck on the app's loading spinner (`#root` never mounts, just the `.app-loader` spinner) after the dev server behind it is stopped and restarted - even though the new server instance is fully healthy. Confirmed healthy by loading the exact same URL in an unrelated browser context, where it mounted immediately (WS showed "Connected"), and by checking that every request (`GET /`, `/src/index.dev.tsx`, `/nonce`, etc.) returned 200. So this is client-side state in that specific tab, not a server problem - do not spend time re-checking `yarn dev`'s own output once you've confirmed it started cleanly (`VITE ... ready`, `WebSocket agent ready`, no `EADDRINUSE`).

Fix: hard refresh the stuck tab (`Ctrl+Shift+R` / `Ctrl+F5`), not a plain reload - confirmed to resolve it. If that doesn't help, try a private/incognito window to rule out extensions or other cached state.

Not confirmed as the cause here, but worth checking first if hard refresh doesn't help: this machine also runs VPN/proxy software (OpenVPN, Hiddify). If the affected browser routes local traffic through one, that can interfere with `localhost`/LAN requests in that browser specifically while an unaffected browser loads the same URL fine.
