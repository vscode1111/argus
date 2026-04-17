#!/usr/bin/env node
'use strict';

const { execSync } = require('child_process');
const PORT = 5173;

const lines = execSync('netstat -ano').toString().split('\n');
const line = lines.find(l => l.includes(`:${PORT}`) && l.includes('LISTENING'));

if (!line) {
  console.log(`Nothing running on port ${PORT}`);
  process.exit(0);
}

const pid = line.trim().split(/\s+/).pop();
execSync(`taskkill /PID ${pid} /F`);
console.log(`Stopped PID ${pid} (port ${PORT})`);
