#!/usr/bin/env node
// Appends the backticks-in-node-e lesson to the development.md Summary cell in both index
// copies at once. Idempotent.
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..', '..', '..');
const FILES = [
  path.join(ROOT, '!notes', 'common', 'INDEX.md'),
  path.join(ROOT, '!notes', 'INDEX.md'),
];

const MARKER = 'backticks inside a double-quoted';
const ADD = '; backticks inside a double-quoted `node -e` are executed by bash, so markdown prose written that way arrives with the backticked words deleted';

let changed = 0;
for (const file of FILES) {
  const src = fs.readFileSync(file, 'utf8');
  if (src.includes(MARKER)) { console.log('already current:', file); continue; }
  const lines = src.split(/\r?\n/);
  const i = lines.findIndex(l => l.trimStart().startsWith('|') && l.includes('development.md'));
  if (i < 0) { console.error('ROW NOT FOUND in', file); process.exitCode = 1; continue; }
  const line = lines[i];
  if (!line.endsWith(' |')) { console.error('UNEXPECTED ROW END in', file); process.exitCode = 1; continue; }
  lines[i] = line.slice(0, -2) + ADD + ' |';
  fs.writeFileSync(file, lines.join('\n'));
  changed++;
  console.log('rewritten:', file);
}
console.log(`changed ${changed} file(s)`);
