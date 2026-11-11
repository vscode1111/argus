import { test, expect } from './provider-fixtures';
import { spawn } from 'node:child_process';
import * as net from 'node:net';
import * as path from 'node:path';
import { WebSocket } from 'ws';

test('the development server still answers after its output readers disconnect', { tag: ['@shared'] }, async () => {
  const reservation = net.createServer();
  await new Promise<void>(resolve => reservation.listen(0, '127.0.0.1', resolve));
  const port = (reservation.address() as net.AddressInfo).port;
  await new Promise<void>(resolve => reservation.close(() => resolve()));
  const root = path.resolve(__dirname, '..');
  const child = spawn(process.execPath, ['-r', 'tsx/cjs', '-e', `
    require('./server/index.ts');
    process.on('message', () => {
      setInterval(() => {
        process.stdout.write('output after disconnect');
        process.stderr.write('error output after disconnect');
      }, 10);
      setTimeout(() => process.send('responsive'), 250);
    });
  `], {
    cwd: root,
    env: { ...process.env, ARGUS_SERVER_PORT: String(port), ARGUS_USAGE_POLL: '0' },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    windowsHide: true,
  });
  if (!child.stdout || !child.stderr) throw new Error('Expected piped child output');
  child.stdout.resume();
  child.stderr.resume();
  let responsive = false;
  child.on('message', message => { if (message === 'responsive') responsive = true; });
  let socket: WebSocket | undefined;
  try {
    await expect.poll(async () => {
      try { return (await fetch(`http://127.0.0.1:${port}/health`)).ok; }
      catch { return false; }
    }).toBe(true);
    const nonce = (await (await fetch(`http://127.0.0.1:${port}/nonce`)).text()).trim();
    child.stdout.destroy();
    child.stderr.destroy();
    child.send('write');
    await expect.poll(() => responsive).toBe(true);
    socket = new WebSocket(`ws://127.0.0.1:${port}/agent?nonce=${encodeURIComponent(nonce)}&dir=${encodeURIComponent(root)}&client=browser`, {
      origin: 'http://localhost:5173',
    });
    let answered = false;
    socket.on('message', data => { if (JSON.parse(data.toString()).type === 'workspaceInfo') answered = true; });
    await new Promise<void>((resolve, reject) => { socket!.once('open', resolve); socket!.once('error', reject); });
    socket.send(JSON.stringify({ type: 'getInfo' }));
    await expect.poll(() => answered).toBe(true);
  } finally {
    socket?.terminate();
    const exited = new Promise<void>(resolve => child.once('exit', () => resolve()));
    if (child.exitCode === null && child.signalCode === null) { child.kill(); await exited; }
  }
});
