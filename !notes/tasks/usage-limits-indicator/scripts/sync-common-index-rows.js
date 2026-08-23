// Applies this task's index changes to BOTH !notes/common/INDEX.md and the root
// !notes/INDEX.md in one run. The root mirrors common/INDEX.md byte-for-byte in the
// Summary cell (only the link path differs), so hand-editing each file separately is
// how the two copies drift.
//
// Usage: node "!notes/tasks/usage-limits-indicator/scripts/sync-common-index-rows.js"
// Idempotent: re-running detects each marker and does nothing.

const fs = require('fs');
const path = require('path');

const repoRoot = path.resolve(__dirname, '..', '..', '..', '..');
const COMMON_INDEX = path.join(repoRoot, '!notes', 'common', 'INDEX.md');
const ROOT_INDEX = path.join(repoRoot, '!notes', 'INDEX.md');

/** Append a clause to an existing row's Summary cell. */
const EDITS = [
  {
    doc: 'oauth-usage-api.md',
    anchor: '429 rate-limiting',
    clause:
      ' (common under dev load, and it outlives one window); poll it centrally - one poller per ' +
      'server process, activity-gated to once a minute and paused after an idle hour, keeping the ' +
      'last snapshot on failure, with `ARGUS_USAGE_POLL=0` for tests',
    marker: 'one poller per server process',
  },
  {
    doc: 'e2e-testing.md',
    anchor: 'only the final hit test fails)',
    clause:
      '; to prove data came from a background job assert its age at the moment of the request (an ' +
      'absolute cutoff taken at startup reds a working build, since the job finishes after `listen`) ' +
      'and pair it with a job-disabled control; a spec depending on a live external API must skip on ' +
      'a bad probe yet still assert the round trip unconditionally, and the suite itself must not ' +
      'exhaust the quota',
    marker: 'assert its age at the moment of the request',
  },
  {
    doc: 'oauth-usage-api.md',
    anchor: 'with `ARGUS_USAGE_POLL=0` for tests',
    clause:
      '; client-triggered refreshes go through the same module (`requestUsageRefresh`), floored at ' +
      'one request per minute from the last *attempt*, so N panels clicking refresh cost one call',
    marker: 'client-triggered refreshes go through the same module',
  },
  {
    doc: 'development.md',
    anchor: 'hard refresh fixes it',
    clause:
      '; recurring work registered in `daemon.ts` never runs under `yarn dev` (two entry points over ' +
      'one `startServer`), which reads as a missing feature - put it in `startServer` with an env ' +
      'kill switch, and note `scheduleModelDataRefresh` still has this gap',
    marker: 'never runs under `yarn dev`',
  },
];

/** Insert a whole new row after the row matching `after`. */
const NEW_ROWS = [
  {
    after: 'oauth-usage-api.md',
    marker: 'rate-limited-external-apis.md',
    row: (linkPrefix) =>
      `| [rate-limited-external-apis.md](${linkPrefix}rate-limited-external-apis.md) | Calling a rate-limited API from a many-client server | ` +
      'One module owns the call and handlers do not import it (the invariant is greppable); clients ask rather than fetch, ' +
      'so N panels clicking refresh cost one request; the floor is measured from the last **attempt**, never the last success ' +
      '(during a 429 there is no success to measure from); a failure keeps the last good data on both sides of the wire and only ' +
      'records the reason; the result is broadcast so no panel holds a private copy that can drift; env kill switch for the e2e suite |',
  },
  {
    after: 'overlay-controls-on-scrollable.md',
    marker: 'ui-that-reads-as-broken.md',
    // The link path is the only difference between the two files.
    row: (linkPrefix) =>
      `| [ui-that-reads-as-broken.md](${linkPrefix}ui-that-reads-as-broken.md) | UI that renders correctly but reads as broken | ` +
      'A VS Code colour token is not a promise of contrast: `--input-bg` equals the surface in the Dark 2026 theme, ' +
      'so a progress track painted with it is invisible and the bar looks like a floating stub (use `--track-bg`, ' +
      'a `color-mix` of `--fg`); and a widget that can render empty must carry the reason it is empty, or a correct ' +
      'no-data state is reported as a missing feature; neither is caught by layout or logic assertions, so compare ' +
      'computed colours and assert the reason text |',
  },
];

let changed = 0;
for (const file of [COMMON_INDEX, ROOT_INDEX]) {
  const src = fs.readFileSync(file, 'utf8');
  const eol = src.includes('\r\n') ? '\r\n' : '\n';
  const lines = src.split(/\r?\n/);
  const linkPrefix = file === ROOT_INDEX ? 'common/' : '';
  let touched = false;

  for (const edit of EDITS) {
    const i = lines.findIndex(l => l.includes(edit.doc) && l.trimStart().startsWith('|'));
    if (i < 0) { console.log('row not found:', edit.doc, 'in', file); continue; }
    if (lines[i].includes(edit.marker)) { console.log('already present:', edit.doc, 'in', file); continue; }
    const at = lines[i].toLowerCase().indexOf(edit.anchor.toLowerCase());
    if (at < 0) { console.log('anchor missing:', edit.doc, 'in', file); continue; }
    const end = at + edit.anchor.length;
    lines[i] = lines[i].slice(0, end) + edit.clause + lines[i].slice(end);
    touched = true;
  }

  for (const nr of NEW_ROWS) {
    if (lines.some(l => l.includes(nr.marker))) { console.log('row already present:', nr.marker, 'in', file); continue; }
    const i = lines.findIndex(l => l.includes(nr.after) && l.trimStart().startsWith('|'));
    if (i < 0) { console.log('anchor row missing:', nr.after, 'in', file); continue; }
    lines.splice(i + 1, 0, nr.row(linkPrefix));
    touched = true;
  }

  if (touched) { fs.writeFileSync(file, lines.join(eol)); changed++; console.log('updated:', file); }
}
console.log('files changed:', changed);
