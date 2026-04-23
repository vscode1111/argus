#!/usr/bin/env node
'use strict';

const { spawn } = require('child_process');
const path = require('path');

const isWin = process.platform === 'win32';
const viteBin = path.join(__dirname, '..', 'node_modules', '.bin', isWin ? 'vite.cmd' : 'vite');

const procs = [
  {
    name: 'fe',
    color: '\x1b[36m',
    cmd: isWin ? `"${viteBin}"` : viteBin,
    args: ['--config', 'webview/vite.dev.config.ts'],
    shell: isWin,
  },
  {
    name: 'be',
    color: '\x1b[32m',
    cmd: process.execPath,
    args: ['--experimental-strip-types', '--no-warnings=ExperimentalWarning', 'server/index.ts'],
  },
];

const reset = '\x1b[0m';
const children = [];

for (const p of procs) {
  const child = spawn(p.cmd, p.args, { stdio: ['ignore', 'pipe', 'pipe'], shell: p.shell === true });
  children.push(child);

  const tag = `${p.color}[${p.name}]${reset} `;
  const forward = (stream) => {
    let buf = '';
    stream.on('data', (chunk) => {
      buf += chunk.toString();
      const lines = buf.split('\n');
      buf = lines.pop();
      for (const line of lines) process.stdout.write(tag + line + '\n');
    });
    stream.on('end', () => { if (buf) process.stdout.write(tag + buf + '\n'); });
  };
  forward(child.stdout);
  forward(child.stderr);

  child.on('exit', (code, signal) => {
    process.stdout.write(`${tag}exited (${signal || code})\n`);
    for (const c of children) if (c !== child && !c.killed) c.kill();
    process.exit(code ?? 1);
  });
}

const shutdown = () => {
  for (const c of children) if (!c.killed) c.kill();
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
