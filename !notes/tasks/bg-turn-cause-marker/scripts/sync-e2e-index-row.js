#!/usr/bin/env node
// Appends this session's two e2e lessons to the e2e-testing.md Summary cell, in both index
// copies at once (root INDEX.md mirrors common/INDEX.md byte-identically). Idempotent.
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..', '..', '..');
const FILES = [
  path.join(ROOT, '!notes', 'common', 'INDEX.md'),
  path.join(ROOT, '!notes', 'INDEX.md'),
];

// Anchor on the end of the existing cell: the row ends with " |" at end of line.
const MARKER = 'a payload copied from a transcript';
const ADD = '; a payload copied from a transcript is not evidence about the stream (a live handler gated on a transcript-only field was dead code with a passing test); quote the `-g` pattern when a script shells out to Playwright, or the grep silently becomes one word and the harness reports a verdict about itself';

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
