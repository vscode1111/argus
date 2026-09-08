#!/usr/bin/env node
// Rewrites the tail of the cli-turn-boundaries Summary cell in both index copies in one run,
// so the byte-identical requirement cannot be broken by two hand edits. Idempotent: it exits
// clean once the new wording is already present.
//
// A file, not an inline `node -e`: these cells cross two escaping layers and a silent
// no-op replacement has burned this repo twice.
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..', '..', '..');
const FILES = [
  path.join(ROOT, '!notes', 'common', 'INDEX.md'),
  path.join(ROOT, '!notes', 'INDEX.md'),
];

const OLD = 'live it is dropped only by accident, on replay it must both be hidden and `finalize()` the turn, or a whole watch merges into one message';
const NEW = 'that record is **transcript-only** (live, a finished task announces itself as a `system`/`task_notification` event instead, measured 2026-09-08), and on replay it must both be hidden and `finalize()` the turn, or a whole watch merges into one message';

let changed = 0;
for (const file of FILES) {
  const src = fs.readFileSync(file, 'utf8');
  if (src.includes(NEW)) { console.log('already current:', file); continue; }
  const hits = src.split(OLD).length - 1;
  if (hits !== 1) { console.error(`ANCHOR MISS (${hits} hits) in ${file}`); process.exitCode = 1; continue; }
  fs.writeFileSync(file, src.split(OLD).join(NEW));
  changed++;
  console.log('rewritten:', file);
}
console.log(`changed ${changed} file(s)`);
