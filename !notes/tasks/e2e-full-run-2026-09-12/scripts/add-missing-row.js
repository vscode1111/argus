// Index hygiene: !notes/tasks/cli-process-list-no-reply/ has a notes.md but no row in
// tasks/INDEX.md (a prior session's write, caught by the folder-direction check that walks
// the disk rather than the index). Summary written from that note, not invented.
// Idempotent via the slug.
const fs = require('fs');

const SLUG = 'cli-process-list-no-reply';
const MODULE = 'webview/SettingsModal+CliProcessesModal, backend/processes (diagnosis only, no fix committed)';
const SUMMARY = 'NOT A BUG: "CLI processes `-`, modal stuck on Loading..." was the first '
  + '~500ms. Sampling the real UI against the live daemon every 100ms showed `-` at 87/310/423ms '
  + 'and the full table at 533ms - `getServerInfo` answers synchronously while '
  + '`listCliProcesses` shells out to PowerShell, and both leave the same `useEffect` one line '
  + 'apart, so the slower round trip read as a fault. Ruled out with evidence: daemon age/handler '
  + 'presence (discovery file + compiled bundle), `listCliProcesses` hanging (382ms on the '
  + 'compiled bundle), the `VS_ONLY` routing trap (not in the list), the server dropping requests '
  + 'under the modal\'s 3s polling (8/8 answered in 362-492ms via `hammer-live-daemon.js`), and a '
  + 'stale webview bundle. Two real defects found while checking and still open: `-` means both '
  + '"still asking" and "could not look" (`liveProcesses` is null in each case, so normal latency '
  + 'is indistinguishable from a failed listing), and the client give-up deadline equals the '
  + 'server worst case (`REPLY_TIMEOUT_MS` 10s vs `PS_TIMEOUT_MS` 10s), so a PowerShell timeout '
  + 'guarantees the client first shows a confidently wrong "your daemon may be too old"';

const f = '!notes/tasks/INDEX.md';
const raw = fs.readFileSync(f, 'utf8');
if (raw.includes(`${SLUG}/`)) { console.log('skip (already present)'); process.exit(0); }
const lines = raw.split(/\r?\n/);
const sep = lines.findIndex(l => /^\|\s*-+/.test(l));
lines.splice(sep + 1, 0, `| [${SLUG}/](${SLUG}/) | ${MODULE} | ${SUMMARY} |`);
fs.writeFileSync(f, lines.join('\n'));
console.log(`patched: ${f} (after line ${sep + 1})`);
