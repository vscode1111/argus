#!/usr/bin/env node
// Appends the "never run a mock spec during the integration project" lesson to the
// e2e-testing.md Summary cell in both index copies at once. Idempotent.
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..', '..', '..');
const FILES = [
  path.join(ROOT, '!notes', 'common', 'INDEX.md'),
  path.join(ROOT, '!notes', 'INDEX.md'),
];

const MARKER = 'never run a mock spec while the integration project';
const ADD = '; never run a mock spec while the integration project is running (it wipes `test-results/`, destroying the artifacts of a failure that just happened, and is the same overload `workers: 1` exists to prevent, surfacing as a product bug in an unrelated spec)';

let changed = 0;
for (const file of FILES) {
  const src = fs.readFileSync(file, 'utf8');
  if (src.includes(MARKER)) { console.log('already current:', file); continue; }
  const lines = src.split(/\r?\n/);
  const i = lines.findIndex(l => l.trimStart().startsWith('|') && l.includes('e2e-testing.md'));
  if (i < 0) { console.error('ROW NOT FOUND in', file); process.exitCode = 1; continue; }
  const line = lines[i];
  if (!line.endsWith(' |')) { console.error('UNEXPECTED ROW END in', file); process.exitCode = 1; continue; }
  lines[i] = line.slice(0, -2) + ADD + ' |';
  fs.writeFileSync(file, lines.join('\n'));
  changed++;
  console.log('rewritten:', file);
}
console.log(`changed ${changed} file(s)`);
