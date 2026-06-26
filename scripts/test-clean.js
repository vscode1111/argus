// Kill leftover processes from interrupted e2e runs: orphaned Claude CLIs, stale
// dev servers (Vite / server/index.ts), Playwright runners, Playwright's own
// chromium, and stray test daemons. Deliberately conservative - it never kills:
//   - this very session (the whole ancestor chain of this script, so the Claude
//     process running the agent and its node parents are safe),
//   - the real Argus daemon (the pid in ~/.claude/argus-daemon.json),
//   - your normal browser (only Playwright-spawned chromium is matched).
//
// Usage: node scripts/test-clean.js [--dry] [--no-claude]
//   --dry        list what would be killed, kill nothing
//   --no-claude  do not touch any claude.exe (extra-safe)
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const DRY = process.argv.includes('--dry');
const NO_CLAUDE = process.argv.includes('--no-claude');
const IS_WIN = process.platform === 'win32';

// --- enumerate processes: [{ pid, ppid, name, cmd }] ---
function listProcesses() {
  if (IS_WIN) {
    const ps = 'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,CommandLine | ConvertTo-Json -Compress';
    const out = execFileSync('powershell', ['-NoProfile', '-Command', ps], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    const arr = JSON.parse(out);
    return (Array.isArray(arr) ? arr : [arr]).map((p) => ({
      pid: p.ProcessId, ppid: p.ParentProcessId, name: (p.Name || '').toLowerCase(), cmd: p.CommandLine || '',
    }));
  }
  const out = execFileSync('ps', ['-eo', 'pid=,ppid=,comm=,args='], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return out.split('\n').filter(Boolean).map((line) => {
    const m = line.trim().match(/^(\d+)\s+(\d+)\s+(\S+)\s*(.*)$/);
    if (!m) return null;
    return { pid: +m[1], ppid: +m[2], name: m[3].toLowerCase(), cmd: m[4] || '' };
  }).filter(Boolean);
}

function kill(pid) {
  try {
    if (IS_WIN) execFileSync('taskkill', ['/F', '/T', '/PID', String(pid)], { stdio: 'ignore' });
    else process.kill(pid, 'SIGKILL');
    return true;
  } catch { return false; }
}

const procs = listProcesses();
const byPid = new Map(procs.map((p) => [p.pid, p]));

// Protected: the ancestor chain of this script (so we never kill the session).
const protectedPids = new Set();
let cur = process.pid;
while (cur && byPid.has(cur) && !protectedPids.has(cur)) {
  protectedPids.add(cur);
  cur = byPid.get(cur).ppid;
}

// Protected: the real daemon.
try {
  const info = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.claude', 'argus-daemon.json'), 'utf8'));
  if (typeof info.pid === 'number') protectedPids.add(info.pid);
} catch { /* no real daemon */ }

// --- classify kill targets ---
function classify(p) {
  if (protectedPids.has(p.pid)) return null;
  const c = p.cmd;
  if (p.name === 'node.exe' || p.name === 'node') {
    if (/@playwright[\\/]test|playwright[\\/]cli|cli\.js["']?\s+test/i.test(c)) return 'playwright-runner';
    if (/[\\/]vite[\\/]|vite\.config|scripts[\\/]dev\.js|server[\\/]index\.ts/i.test(c)) return 'dev-server';
    if (/out[\\/]backend[\\/]daemon\.js|src[\\/]backend[\\/]daemon\.ts/i.test(c)) return 'stray-daemon';
    return null;
  }
  if (p.name === 'chrome.exe' || p.name === 'chrome' || p.name === 'chromium') {
    if (/ms-playwright|playwright-mcp|playwright[\\/].*chrome/i.test(c)) return 'playwright-chromium';
    return null; // user's real browser - leave it
  }
  // Only non-interactive agent CLIs (--print, as the Argus backend and e2e spawn
  // them) - never an interactive Claude Code REPL session.
  if ((p.name === 'claude.exe' || p.name === 'claude') && !NO_CLAUDE && /--print\b/.test(c)) return 'claude-orphan';
  return null;
}

const targets = [];
for (const p of procs) {
  const kind = classify(p);
  if (kind) targets.push({ ...p, kind });
}

if (targets.length === 0) {
  console.log('[test-clean] nothing to clean');
  process.exit(0);
}

const counts = {};
for (const t of targets) counts[t.kind] = (counts[t.kind] || 0) + 1;
console.log(`[test-clean] ${DRY ? 'would kill' : 'killing'} ${targets.length} process(es): ${Object.entries(counts).map(([k, n]) => `${k}=${n}`).join(', ')}`);

if (DRY) {
  for (const t of targets) console.log(`  ${t.kind}\tpid=${t.pid}\t${t.cmd.slice(0, 80)}`);
  process.exit(0);
}

let killed = 0;
for (const t of targets) if (kill(t.pid)) killed++;
console.log(`[test-clean] killed ${killed}/${targets.length}`);
