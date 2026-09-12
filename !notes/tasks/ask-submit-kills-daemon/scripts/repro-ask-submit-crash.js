// Reproduces: submitting an AskUserQuestion answer kills the whole server process,
// dropping every connected client (not just the one that clicked Submit).
//
// End-to-end against the REAL compiled daemon. The only thing faked is the Claude CLI
// itself: resolveClaudeBin() resolves it with `where claude.cmd`, so a stub first on
// PATH makes the stdout deterministic and takes the model out of the loop. Everything
// after that - handleAssistant, the AskUserQuestion intercept, toolMap, the WS message
// handler, flushAskFollowUp - is production code in a production process.
//
// The `questions` payload is copied verbatim from the reported transcript
// (f576b729-8c1a-4da0-a079-14e598a30ccb.jsonl line 62), where the model recorded it as
// a JSON string rather than an array.
//
// Usage: node repro-ask-submit-crash.js
//        node repro-ask-submit-crash.js --array   <- control: same run, `questions`
//                                                    delivered as an array instead of
//                                                    a string. The toggle that proves
//                                                    the string is the cause.
// Exit 0 = the bug did NOT reproduce (daemon survived). Exit 1 = reproduced.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execFileSync } = require('child_process');

const REPO = path.resolve(__dirname, '../../../..');
const DAEMON_JS = path.join(REPO, 'out/backend/daemon.js');
const PORT = 3711;
const TOOL_ID = 'toolu_scub_ask_1';

// Verbatim from the reported transcript: the model put `questions` in as a string.
const QUESTIONS_STRING = JSON.stringify([
  {
    question: "Should each row have an action (like the CLI list's per-row terminate), or is this read-only?",
    header: 'Row action',
    multiSelect: false,
    options: [
      { label: 'Read-only list', description: 'Just the list - no way to kick a client.' },
      { label: 'Disconnect button', description: 'Per-row close, mirroring the CLI list trash button.' },
      { label: 'Disconnect + block origin', description: 'Closes the socket AND blocks its origin.' },
    ],
  },
]);
const QUESTION_TEXT = JSON.parse(QUESTIONS_STRING)[0].question;

// Control run: the same payload as a real array, which is what the schema says and what
// the CLI usually sends. If the daemon survives this and dies on the string, the string
// is the cause.
const AS_ARRAY = process.argv.includes('--array');
const QUESTIONS_PAYLOAD = AS_ARRAY ? JSON.parse(QUESTIONS_STRING) : QUESTIONS_STRING;

// Run the same scenario against the dev server entry point instead of the daemon. It
// is the same startServer(), differing only in that it installs an uncaughtException
// handler - so this says whether the process death is the daemon's own gap.
const DEV_SERVER = process.argv.includes('--dev-server');

const log = (...a) => console.log(...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function requireWs() {
  try { return require(path.join(REPO, 'node_modules/ws')); } catch { return require('ws'); }
}
const WebSocket = requireWs();

function alive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

async function waitFor(cond, ms, label) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (await cond()) return true;
    await sleep(100);
  }
  throw new Error(`timed out waiting for ${label}`);
}

// A ws client that buffers every frame from construction. A server replay sent during
// the upgrade can share a TCP read with the handshake and be emitted before a listener
// attached after `open` exists.
function connect(url) {
  const ws = new WebSocket(url);
  const frames = [];
  const closes = [];
  ws.on('message', (d) => { try { frames.push(JSON.parse(d.toString())); } catch {} });
  ws.on('close', (code, reason) => closes.push({ code, reason: String(reason || '') }));
  ws.on('error', () => {});
  return {
    ws, frames, closes,
    open: new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej); }),
    send: (o) => ws.send(JSON.stringify(o)),
    got: (type, pred) => frames.find((f) => f.type === type && (!pred || pred(f))),
  };
}

async function main() {
  if (!fs.existsSync(DAEMON_JS)) {
    log(`! ${DAEMON_JS} missing - run \`yarn compile\` first`);
    process.exit(2);
  }

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'scub-ask-repro-'));
  const stubDir = path.join(tmp, 'stub');
  const workspace = path.join(tmp, 'workspace');
  const configFile = path.join(tmp, 'argus.json');
  const daemonFile = path.join(tmp, 'daemon.json');
  fs.mkdirSync(stubDir);
  fs.mkdirSync(workspace);
  fs.writeFileSync(configFile, JSON.stringify({ watchdogEnabled: false, cliIdleTimeoutSec: 0 }));

  // The stub CLI: on the first stdin line, announce a session id then emit one
  // assistant event holding the captured AskUserQuestion block. Stays alive so the
  // daemon's intercept has a process to kill, exactly as the real CLI does.
  fs.writeFileSync(path.join(stubDir, 'stub.js'), `
const fs = require('fs');
const STDIN_LOG = ${JSON.stringify(path.join(tmp, 'cli-stdin.log'))};
const lines = [];
process.stdin.on('data', (d) => {
  // Ground truth for "did the answers reach the model": what was actually written to the
  // CLI's stdin, rather than which WS frames the UI happened to see.
  try { fs.appendFileSync(STDIN_LOG, d); } catch {}
  lines.push(d);
  if (lines.length > 1) return;
  process.stdout.write(JSON.stringify({ type: 'system', subtype: 'init', session_id: '11111111-2222-3333-4444-555555555555' }) + '\\n');
  process.stdout.write(JSON.stringify({
    type: 'assistant',
    message: { model: 'scub-model', content: [
      { type: 'tool_use', id: ${JSON.stringify(TOOL_ID)}, name: 'AskUserQuestion', input: { questions: ${JSON.stringify(QUESTIONS_PAYLOAD)} } },
    ] },
  }) + '\\n');
});
setInterval(() => {}, 1000);
`);
  fs.writeFileSync(path.join(stubDir, 'claude.cmd'), `@echo off\r\nnode "%~dp0stub.js" %*\r\n`);

  log(`mode:      questions as ${AS_ARRAY ? 'ARRAY (control run)' : 'STRING (as the reported transcript recorded it)'}`);
  log(`stub CLI:  ${stubDir}\\claude.cmd`);
  log(`workspace: ${workspace}`);

  const env = {
    ...process.env,
    PATH: stubDir + path.delimiter + process.env.PATH,
    Path: stubDir + path.delimiter + (process.env.Path || process.env.PATH),
    ARGUS_CONFIG: configFile,
    ARGUS_MODEL_REFRESH: '0',
    ARGUS_USAGE_POLL: '0',
  };
  // Two server entry points share one startServer(): the daemon (what VS Code panels
  // connect to) and the dev server. Only the dev server installs an uncaughtException
  // handler, so which one is under test decides whether a throw is survivable.
  const daemon = DEV_SERVER
    ? spawn('npx', ['tsx', path.join(REPO, 'server/index.ts')], {
        cwd: REPO, shell: true, stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...env, ARGUS_SERVER_PORT: String(PORT) },
      })
    : spawn(process.execPath, [DAEMON_JS], {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
          ...env,
          ARGUS_DAEMON_PORT: String(PORT),
          ARGUS_DAEMON_FILE: daemonFile,
          ARGUS_DAEMON_IDLE_MS: String(10 * 60 * 1000),
        },
      });
  let dstdout = '', dstderr = '';
  daemon.stdout.on('data', (d) => { dstdout += d; });
  daemon.stderr.on('data', (d) => { dstderr += d; });

  const cleanup = () => {
    if (alive(daemon.pid)) {
      try { execFileSync('taskkill', ['/T', '/F', '/PID', String(daemon.pid)], { stdio: 'ignore' }); } catch {}
    }
  };
  process.on('exit', cleanup);

  try {
    let info;
    if (DEV_SERVER) {
      // No discovery file on this path; the nonce comes off GET /nonce.
      await waitFor(async () => {
        try {
          const r = await fetch(`http://127.0.0.1:${PORT}/nonce`);
          if (!r.ok) return false;
          info = { pid: daemon.pid, port: PORT, nonce: (await r.text()).trim(), version: 'dev' };
          return true;
        } catch { return false; }
      }, 60000, 'dev server /nonce');
    } else {
      await waitFor(() => fs.existsSync(daemonFile), 15000, 'discovery file');
      info = JSON.parse(fs.readFileSync(daemonFile, 'utf8'));
    }
    log(`server:    ${DEV_SERVER ? 'DEV (server/index.ts, has uncaughtException net)' : 'DAEMON (out/backend/daemon.js)'} pid ${info.pid}, port ${info.port}, version ${info.version}`);

    const base = `ws://127.0.0.1:${info.port}/agent?nonce=${info.nonce}&dir=${encodeURIComponent(workspace)}&client=browser`;
    const A = connect(base);
    const B = connect(base);
    await A.open; await B.open;
    log('clients:   A (will submit) and B (bystander, own session entry) connected');

    A.send({ type: 'send', text: 'scub-ask' });
    await waitFor(async () => A.got('tool_start', (f) => f.call && f.call.name === 'AskUserQuestion'), 20000, 'AskUserQuestion tool_start');
    log('           A received the AskUserQuestion dialog');

    const before = {
      daemonAlive: alive(info.pid),
      aOpen: A.ws.readyState === 1,
      bOpen: B.ws.readyState === 1,
    };
    log(`before:    daemon alive=${before.daemonAlive}  A open=${before.aOpen}  B open=${before.bOpen}`);

    // The Submit click. Mark the frame cursor first: `message` is also the echo of A's
    // own original send, so only frames that arrive AFTER this point are evidence that
    // the answers reached the model.
    const cursor = A.frames.length;
    log('--> A sends toolAnswer (the Submit click)');
    A.send({ type: 'toolAnswer', id: TOOL_ID, answers: { [QUESTION_TEXT]: 'Read-only list' } });

    await sleep(3000);

    const after = {
      daemonAlive: alive(info.pid),
      aOpen: A.ws.readyState === 1,
      bOpen: B.ws.readyState === 1,
      exitCode: daemon.exitCode,
    };
    log(`after:     daemon alive=${after.daemonAlive}  A open=${after.aOpen}  B open=${after.bOpen}  exitCode=${after.exitCode}`);
    if (A.closes.length) log(`           A close: ${JSON.stringify(A.closes[0])}`);
    if (B.closes.length) log(`           B close: ${JSON.stringify(B.closes[0])}`);

    const crashLine = dstderr.split(/\r?\n/).filter(Boolean).slice(0, 12).join('\n');
    if (crashLine) log(`\ndaemon stderr:\n${crashLine}`);

    // Did the answers actually reach the model? Read the CLI's stdin, not the WS frames:
    // the follow-up is sent with `_silent: true`, so it deliberately produces no `message`
    // echo, and judging it by frames is how this probe first mis-reported a working fix.
    const post = A.frames.slice(cursor);
    log(`           frames to A after submit: ${post.map((f) => f.type).join(', ') || '(none)'}`);

    // If the daemon's crash net caught something, it reports it into every panel's Debug
    // Log - the daemon's stdout is discarded in the real deployment, so this is the only
    // place a user would ever see it.
    const crashLog = post.find((f) => f.type === 'log' && String(f.text || '').startsWith('Daemon '));
    if (crashLog) log(`           crash net reported to the panel: ${String(crashLog.text).split('\n')[0].slice(0, 120)}`);

    const stdinLog = path.join(tmp, 'cli-stdin.log');
    const written = fs.existsSync(stdinLog) ? fs.readFileSync(stdinLog, 'utf8') : '';
    const followUp = written.includes('The user has now answered your earlier questions')
      && written.includes('Read-only list');
    const optionDetail = /\(option \d+ of \d+\)/.exec(written);
    log(`           follow-up reached the CLI stdin: ${followUp}${optionDetail ? ` ${optionDetail[0]}` : ''}`);

    const crashed = !after.daemonAlive || !after.bOpen;
    const reproduced = crashed || !followUp;
    log('');
    if (crashed) {
      log('REPRODUCED (crash): the Submit click killed the server process and dropped');
      log('                    the bystander client that had nothing to do with the dialog.');
    } else if (!followUp) {
      log('REPRODUCED (silent drop): the process survived, but no follow-up was sent -');
      log('                          the answers were swallowed and the turn never resumes.');
    } else {
      log('NOT REPRODUCED: process alive, both clients connected, follow-up delivered.');
    }
    try { A.ws.close(); B.ws.close(); } catch {}
    await sleep(200);
    cleanup();
    process.exit(reproduced ? 1 : 0);
  } catch (err) {
    log(`\nHARNESS ERROR: ${err.message}`);
    log(`daemon stdout:\n${dstdout.slice(-2000)}`);
    log(`daemon stderr:\n${dstderr.slice(-2000)}`);
    cleanup();
    process.exit(2);
  }
}

main();
