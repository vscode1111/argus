#!/usr/bin/env node
// Does a process the daemon spawns inherit ARGUS_DAEMON_FORCE_START?
//
// The daemon is force-started (as the documented restart procedure does), and the Claude
// CLIs it spawns are its children, so they inherit its environment - and so does anything
// they spawn, e.g. a `yarn test:e2e` run. This models that inheritance directly: a
// --require preload waits for daemon.js's top-level code to finish, then spawns a child
// from inside the daemon process and records what that child sees.
//
// Usage: node probe-force-start-inheritance.js --daemon-js <path> [--port N]
//   Run it against the pre-fix build too - that is the control, and it must print "1".

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const arg = (n, d) => { const i = process.argv.indexOf(n); return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : d; };

const DAEMON_JS = arg('--daemon-js', path.resolve(__dirname, '..', '..', '..', '..', 'out', 'backend', 'daemon.js'));
const PORT = Number(arg('--port', '3973'));

const tag = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
const tmp = (n) => path.join(os.tmpdir(), `argus-fsprobe-${n}-${tag}`);
const preload = tmp('preload.js');
const result = tmp('result.txt');
const daemonFile = tmp('daemon.json');
const cfgFile = tmp('cfg.json');

fs.writeFileSync(cfgFile, JSON.stringify({}));
// Runs before daemon.js; the timer fires after its synchronous top-level (where the
// delete happens), which is exactly when a CLI would be spawned.
fs.writeFileSync(preload, `
setTimeout(() => {
  const { execFileSync } = require('child_process');
  const seen = execFileSync(process.execPath, ['-e',
    'process.stdout.write(String(process.env.ARGUS_DAEMON_FORCE_START))']).toString();
  require('fs').writeFileSync(${JSON.stringify(result)}, seen);
}, 600);
`);

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  if (!fs.existsSync(DAEMON_JS)) { console.log(`no such build: ${DAEMON_JS}`); process.exit(2); }

  const proc = spawn(process.execPath, ['--require', preload, DAEMON_JS], {
    stdio: 'ignore',
    env: {
      ...process.env,
      ARGUS_DAEMON_FORCE_START: '1',   // the condition under test
      ARGUS_DAEMON_FILE: daemonFile,
      ARGUS_DAEMON_PORT: String(PORT),
      ARGUS_CONFIG: cfgFile,
      ARGUS_MODEL_REFRESH: '0',
      ARGUS_USAGE_POLL: '0',
      ARGUS_DAEMON_IDLE_MS: String(10 * 60 * 1000),
    },
  });

  for (let i = 0; i < 40 && !fs.existsSync(result); i++) await wait(150);

  const seen = fs.existsSync(result) ? fs.readFileSync(result, 'utf8').trim() : '(probe never ran)';
  const bound = fs.existsSync(daemonFile);

  console.log(`build:              ${DAEMON_JS}`);
  console.log(`daemon bound:       ${bound}   (force-start still works)`);
  console.log(`child of daemon saw ARGUS_DAEMON_FORCE_START = ${seen}`);
  console.log(seen === 'undefined'
    ? 'PASS - the flag does not outlive the launch'
    : `FAIL - inherited as ${seen}`);

  try { process.kill(proc.pid); } catch { /* already gone */ }
  await wait(200);
  for (const f of [preload, result, daemonFile, cfgFile]) { try { fs.unlinkSync(f); } catch { /* */ } }
})();
