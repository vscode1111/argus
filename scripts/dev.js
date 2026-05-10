#!/usr/bin/env node
'use strict';

const { spawn } = require('child_process');
const path = require('path');

const isWin = process.platform === 'win32';
const viteBin = path.join(__dirname, '..', 'node_modules', '.bin', isWin ? 'vite.cmd' : 'vite');
const reset = '\x1b[0m';
const feColor = '\x1b[36m';
const beColor = '\x1b[32m';
const feTag = `${feColor}[fe]${reset} `;
const beTag = `${beColor}[be]${reset} `;

function forward(stream, tag) {
  let buf = '';
  stream.on('data', (chunk) => {
    buf += chunk.toString();
    const lines = buf.split('\n');
    buf = lines.pop();
    for (const line of lines) process.stdout.write(tag + line + '\n');
  });
  stream.on('end', () => { if (buf) process.stdout.write(tag + buf + '\n'); });
}

// Frontend (Vite) - long-lived, exit kills everything
const fe = spawn(isWin ? `"${viteBin}"` : viteBin, ['--config', 'webview/vite.dev.config.ts'], {
  stdio: ['ignore', 'pipe', 'pipe'],
  shell: isWin,
});
forward(fe.stdout, feTag);
forward(fe.stderr, feTag);
fe.on('exit', (code, signal) => {
  process.stdout.write(`${feTag}exited (${signal || code})\n`);
  if (be && !be.killed) be.kill();
  process.exit(code ?? 1);
});

// Backend (server) - respawnable via --watch
let be = null;

function startBackend() {
  be = spawn(process.execPath, [
    '--watch', '--watch-path=server', '--watch-path=src/argusServer.ts',
    '--experimental-strip-types', '--no-warnings=ExperimentalWarning',
    'server/index.ts',
  ], { stdio: ['ignore', 'pipe', 'pipe'] });

  forward(be.stdout, beTag);
  forward(be.stderr, beTag);

  be.on('exit', (code, signal) => {
    // --watch restarts with specific signals; don't kill everything
    if (signal === 'SIGTERM') {
      process.stdout.write(`${beTag}restarting...\n`);
      return;
    }
    process.stdout.write(`${beTag}exited (${signal || code})\n`);
    if (!fe.killed) fe.kill();
    process.exit(code ?? 1);
  });
}

startBackend();

const shutdown = () => {
  if (fe && !fe.killed) fe.kill();
  if (be && !be.killed) be.kill();
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
