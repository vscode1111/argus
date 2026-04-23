#!/usr/bin/env node
'use strict';

const { execSync } = require('child_process');
const PORTS = [5173, 3001];

const lines = execSync('netstat -ano').toString().split('\n');

let stopped = 0;
for (const port of PORTS) {
  const line = lines.find(l => l.includes(`:${port}`) && l.includes('LISTENING'));
  if (!line) {
    console.log(`Nothing running on port ${port}`);
    continue;
  }
  const pid = line.trim().split(/\s+/).pop();
  execSync(`taskkill /PID ${pid} /F`);
  console.log(`Stopped PID ${pid} (port ${port})`);
  stopped++;
}

if (!stopped) {
  console.log('No dev processes found');
}
