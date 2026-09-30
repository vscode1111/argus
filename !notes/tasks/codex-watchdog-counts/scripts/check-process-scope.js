const path = require('path');
const { execFileSync } = require('child_process');
const root = path.resolve(__dirname, '../../../..');
const { listCliProcesses, resetProcessSamples } = require(path.join(root, 'out/backend/processes.js'));

(async () => {
  resetProcessSamples();
  const listed = await listCliProcesses({ owned: new Map() });
  if (listed.error) throw new Error(listed.error);
  const raw = execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command',
    "Get-CimInstance Win32_Process -Filter \"Name='codex.exe'\" | Select-Object -ExpandProperty ProcessId"],
  { encoding: 'utf8', windowsHide: true });
  const expected = raw.split(/\r?\n/).map(s => Number(s.trim())).filter(pid => Number.isInteger(pid) && pid > 0);
  const actual = new Set(listed.processes.map(p => p.pid));
  const missing = expected.filter(pid => !actual.has(pid));
  const stamp = Date.now() - 12_000;
  const owned = new Map(expected.length ? [[expected[0], { sessionId: 'scub-provider-session', running: false, lastActivityAt: stamp }]] : []);
  const withOwner = await listCliProcesses({ owned });
  const activityMatches = expected.length ? withOwner.processes.find(p => p.pid === expected[0])?.lastActivityAt === stamp : true;
  console.log(JSON.stringify({ osProcesses: expected.length, listedProcesses: listed.processes.length,
    missingCount: missing.length, missingPids: missing, activityMatches }, null, 2));
  if (missing.length || !activityMatches) process.exitCode = 1;
})().catch(err => { console.error(err); process.exitCode = 1; });
