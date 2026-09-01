// Write the same Summary cell into both !notes/INDEX.md and !notes/common/INDEX.md for
// a set of common docs. Hand-editing the two copies is what let them drift in the first
// place (large-tool-payloads.md: 604 chars in one, 384 in the other). Idempotent: it
// rewrites the row only when the summary differs.
const fs = require('fs');

const ROWS = {
  'large-tool-payloads.md': {
    topic: 'Large payloads a tool hands back',
    summary:
      'A Read of an image returns base64 that dwarfs everything else (23.4MB of a 24.2MB replay payload) and was never rendered - the preview re-read the file instead, so the two sources of truth diverged the moment the agent moved the file; strip at every boundary that feeds the client (live *and* replay are separate paths), leave a readable marker, fetch on demand by the id the protocol already has, resolve it against the session the client is viewing; `ws` leaves compression off and base64 of JPEG barely deflates; test by asserting no frame carries the payload and by deleting the file before the click',
  },
  'development.md': {
    topic: 'Local dev setup',
    summary:
      "Nothing typechecks `webview/` (vite strips types, `tsc -p ./` covers only `src/`) so run `npx tsc -p webview/tsconfig.json --noEmit` by hand; `C:` drive can be completely full, breaking `yarn install` with `ENOSPC` even though the project lives on `D:` (yarn's cache defaults to `C:`); workaround via `--cache-folder`; a tab left open across a `yarn dev` restart can hang on the loading spinner - hard refresh fixes it; recurring work registered in `daemon.ts` never runs under `yarn dev` (two entry points over one `startServer`), which reads as a missing feature - put it in `startServer` with an env kill switch, and note `scheduleModelDataRefresh` still has this gap; `yarn dev:stop` kills the server but not its `tsx watch`/vite supervisors, which respawn it within seconds; a dev server Playwright started can outlive the run holding `ARGUS_CONFIG=e2e/argus.json`, so the closing check after any e2e run is the `configPath` from `/health`, not the port",
  },
};

const FILES = [
  { path: '!notes/common/INDEX.md', link: (doc) => `(${doc})` },
  { path: '!notes/INDEX.md', link: (doc) => `(common/${doc})` },
];

let changed = 0;
for (const file of FILES) {
  const lines = fs.readFileSync(file.path, 'utf8').split(/\r?\n/);
  for (const [doc, { topic, summary }] of Object.entries(ROWS)) {
    const i = lines.findIndex((l) => l.trimStart().startsWith('|') && l.includes(file.link(doc)));
    if (i === -1) { console.log(`row not found: ${doc} in ${file.path}`); continue; }
    const row = `| [${doc}]${file.link(doc)} | ${topic} | ${summary} |`;
    if (lines[i] === row) continue;
    lines[i] = row;
    changed++;
  }
  fs.writeFileSync(file.path, lines.join('\n'));
}
console.log(changed ? `rewrote ${changed} row(s)` : 'already in sync');
