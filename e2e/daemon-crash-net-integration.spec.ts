import { test, expect } from '@playwright/test';
import { spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import WebSocket from 'ws';
import { ensureCompiled, uniqueConfigFile, uniqueDaemonFile, readInfo, isAlive, waitFor, daemonEnv } from './daemonHelpers';

// The daemon serves every VS Code panel and browser tab on the machine at once, so an
// uncaught throw in any handler used to end all of them: measured, one AskUserQuestion
// Submit click exited the process with code 1 and dropped two unrelated clients
// (!notes/tasks/ask-submit-kills-daemon/notes.md). `server/index.ts` had an
// uncaughtException net since it was written; the daemon never got one.
//
// The throw is injected with a `--require` preload rather than a crash-on-demand message,
// deliberately: a product backdoor that makes the server throw would be a liability worth
// more than this test. The preload waits on a trigger file so the crash lands *after* a
// client is connected, which is the only arrangement that can observe the client surviving.

const ROOT = path.resolve(__dirname, '..');
const DAEMON_JS = path.join(ROOT, 'out', 'backend', 'daemon.js');
const PORT = 3736;

let tmp: string;
let proc: ReturnType<typeof spawn> | undefined;
let daemonFile: string;

test.beforeAll(() => ensureCompiled());

test.afterAll(() => {
  if (proc?.pid) { try { process.kill(proc.pid); } catch { /* already gone */ } }
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
});

test('an uncaught throw is survived and reported instead of killing every client', async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'scub-crashnet-'));
  const trigger = path.join(tmp, 'boom');
  const preload = path.join(tmp, 'preload.js');
  // Throws from a timer callback, so it reaches `uncaughtException` exactly as a throw out
  // of a WS message handler does.
  fs.writeFileSync(preload, `
const fs = require('fs');
const timer = setInterval(() => {
  if (fs.existsSync(${JSON.stringify(trigger)})) {
    clearInterval(timer);
    throw new Error('scub-boom');
  }
}, 50);
`);

  daemonFile = uniqueDaemonFile('crashnet');
  proc = spawn(process.execPath, ['--require', preload, DAEMON_JS], {
    cwd: ROOT,
    stdio: 'ignore',
    env: daemonEnv({
      ARGUS_DAEMON_FILE: daemonFile,
      ARGUS_DAEMON_PORT: String(PORT),
      ARGUS_CONFIG: uniqueConfigFile('crashnet'),
      ARGUS_DAEMON_IDLE_MS: String(10 * 60 * 1000),
      ARGUS_MODEL_REFRESH: '0',
      ARGUS_USAGE_POLL: '0',
    }),
  });

  expect(await waitFor(() => fs.existsSync(daemonFile), 15_000)).toBe(true);
  const info = readInfo(daemonFile);

  // Buffer frames from construction: a replay sent during the upgrade can share a TCP
  // read with the handshake and be emitted before a later listener exists.
  const ws = new WebSocket(`ws://127.0.0.1:${info.port}/agent?nonce=${info.nonce}&dir=${encodeURIComponent(tmp)}&client=browser`);
  const frames: Array<Record<string, unknown>> = [];
  let closed = false;
  ws.on('message', (d: Buffer) => { try { frames.push(JSON.parse(d.toString())); } catch { /* non-JSON */ } });
  ws.on('close', () => { closed = true; });
  ws.on('error', () => { /* asserted via `closed` */ });
  await new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej); });

  expect(isAlive(info.pid)).toBe(true);

  fs.writeFileSync(trigger, 'go');

  // The net reports into every panel's Debug Log, because the daemon's stdout is
  // discarded in the real deployment (`ensureDaemon` spawns it with stdio 'ignore'), so
  // a console-only handler would turn a visible crash into an invisible one.
  const gotReport = await waitFor(
    () => frames.some(f => f.type === 'log' && String(f.text ?? '').includes('scub-boom')),
    10_000,
  );
  expect(gotReport).toBe(true);

  // The point of the whole thing: the process and every client outlive the throw.
  expect(isAlive(info.pid)).toBe(true);
  expect(closed).toBe(false);
  expect(ws.readyState).toBe(WebSocket.OPEN);

  // And it still serves requests afterwards rather than sitting wedged.
  ws.send(JSON.stringify({ type: 'getServerInfo' }));
  const stillServing = await waitFor(() => frames.some(f => f.type === 'serverInfo'), 10_000);
  expect(stillServing).toBe(true);

  ws.close();
});
