#!/usr/bin/env node
// Why the daemon single-instance guard test fails: the spec spawns the second daemon
// with stdio 'ignore', so the reason for its exit code is thrown away. This replicates
// e2e/daemon-lifecycle-integration.spec.ts:57 byte for byte, except the second launch
// gets pipes so its stdout/stderr can be read.
//
// Usage: node probe-second-launch.js [--port 3912]

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const ROOT = path.resolve(__dirname, '..', '..', '..', '..');
const DAEMON_JS = path.join(ROOT, 'out', 'backend', 'daemon.js');
const E2E_CONFIG = path.join(ROOT, 'e2e', 'argus.json');

const portArg = process.argv.indexOf('--port');
const PORT = portArg > -1 ? Number(process.argv[portArg + 1]) : 3912;

const tmp = (tag) =>
  path.join(os.tmpdir(), `argus-${tag}-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(cond, timeoutMs) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if (await cond()) return true;
    await wait(100);
  }
  return false;
}

function isAlive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (e) { return e.code === 'EPERM'; }
}

function portUp(port) {
  return new Promise((resolve) => {
    const req = http.get(`http://localhost:${port}/nonce`, (res) => { res.resume(); resolve(res.statusCode === 200); });
    req.on('error', () => resolve(false));
    req.setTimeout(900, () => { req.destroy(); resolve(false); });
  });
}

(async () => {
  const file = tmp('daemon-probe');
  const cfg = tmp('cfg-probe');
  fs.writeFileSync(cfg, JSON.stringify({}));

  // --- first daemon, exactly as daemonHelpers.startDaemon builds it ---
  const firstEnv = {
    ...process.env,
    ARGUS_DAEMON_FILE: file,
    ARGUS_CONFIG: cfg,
    ARGUS_MODEL_REFRESH: '0',
    ARGUS_USAGE_POLL: '0',
    ARGUS_DAEMON_PORT: String(PORT),
  };
  delete firstEnv.ARGUS_DAEMON_IDLE_MS;

  const first = spawn(process.execPath, [DAEMON_JS], { cwd: ROOT, env: firstEnv, stdio: 'ignore' });
  const wrote = await waitFor(async () => fs.existsSync(file), 10_000);
  if (!wrote) { console.log('FAIL: first daemon never wrote its discovery file'); try { first.kill(); } catch {} process.exit(2); }

  const info = JSON.parse(fs.readFileSync(file, 'utf8'));
  console.log(`first daemon: pid ${info.pid} port ${info.port} version ${info.version}`);
  console.log(`  discovery file: ${file}`);
  console.log(`  alive: ${isAlive(info.pid)}  port up: ${await portUp(PORT)}`);

  // --- second launch, exactly as the spec spawns it (plus pipes) ---
  // The spec inherits the worker's env, where playwright.config.ts sets ARGUS_CONFIG
  // to e2e/argus.json and sets neither ARGUS_MODEL_REFRESH nor ARGUS_USAGE_POLL.
  const secondParentEnv = { ...process.env, ARGUS_CONFIG: E2E_CONFIG };
  delete secondParentEnv.ARGUS_MODEL_REFRESH;
  delete secondParentEnv.ARGUS_USAGE_POLL;

  console.log('\n--> second launch (same port + same discovery file)');
  const out = [];
  const code = await new Promise((resolve) => {
    const p = spawn(process.execPath, [DAEMON_JS], {
      env: { ...secondParentEnv, ARGUS_DAEMON_PORT: String(PORT), ARGUS_DAEMON_FILE: file },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    p.stdout.on('data', (b) => out.push(['stdout', b.toString()]));
    p.stderr.on('data', (b) => out.push(['stderr', b.toString()]));
    p.on('exit', resolve);
  });

  console.log(`second launch exit code: ${code}   (spec expects 0)`);
  for (const [stream, text] of out) {
    for (const line of text.split(/\r?\n/)) if (line.trim()) console.log(`  [${stream}] ${line}`);
  }
  if (!out.length) console.log('  (no output at all)');

  const after = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null;
  console.log(`\nafter: first alive=${isAlive(info.pid)}  file pid=${after ? after.pid : '(file gone)'} (expect ${info.pid})`);

  try { process.kill(info.pid); } catch {}
  try { first.kill(); } catch {}
  await wait(300);
  try { fs.unlinkSync(file); } catch {}
  try { fs.unlinkSync(cfg); } catch {}
})();
