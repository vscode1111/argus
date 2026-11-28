#!/usr/bin/env node
// Leak check for a PUBLIC repository: infrastructure details (server and VPN addresses,
// ports, tunnel topology, private keys) handed to strangers are a map for an attacker.
//
//   node scripts/check-leaks.js            staged changes (added lines), the default
//   node scripts/check-leaks.js --all      every tracked file
//
// Two kinds of rule:
//   - built in: any IPv4 address except loopback/unspecified and the RFC 5737
//     documentation ranges (192.0.2.0/24, 198.51.100.0/24, 203.0.113.0/24), and PEM
//     private keys;
//   - private: one regular expression per line in ~/.argus/leak-patterns.txt (or the
//     file named by ARGUS_LEAK_PATTERNS). That list holds the owner's real values and
//     lives OUTSIDE the repository on purpose: committed, it would itself be the leak.
// A line containing `leak-check: allow` is skipped (for deliberate test fixtures).
// Exit 1 when anything is found. Dependency-free.
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const IPV4 = /\b(?:\d{1,3}\.){3}\d{1,3}\b/g;
const PRIVATE_KEY = /-----BEGIN [A-Z ]*PRIVATE KEY-----/;
const ALLOW = 'leak-check: allow';

function allowedIp(ip) {
  const p = ip.split('.').map(Number);
  if (p.some((n) => n > 255)) return true;              // not an address (a version string)
  if (p[0] === 127 || ip === '0.0.0.0' || ip === '255.255.255.255') return true;
  if (p[0] === 192 && p[1] === 0 && p[2] === 2) return true;      // TEST-NET-1
  if (p[0] === 198 && p[1] === 51 && p[2] === 100) return true;   // TEST-NET-2
  if (p[0] === 203 && p[1] === 0 && p[2] === 113) return true;    // TEST-NET-3
  return false;
}

/** Private patterns: one regex per line, `#` comments and blank lines ignored. */
function loadPatterns(file = process.env.ARGUS_LEAK_PATTERNS || path.join(os.homedir(), '.argus', 'leak-patterns.txt')) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return { patterns: [], file, found: false }; }
  const patterns = text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('#'))
    .map((l) => new RegExp(l, 'i'));
  return { patterns, file, found: true };
}

/**
 * Findings in one block of text. Never echoes a private pattern's match in full: the
 * report itself may end up in a log, so it names the rule and the location only.
 */
function scanText(text, patterns = [], where = '') {
  const hits = [];
  text.split(/\r?\n/).forEach((line, i) => {
    if (line.includes(ALLOW)) return;
    const at = where ? `${where}:${i + 1}` : String(i + 1);
    for (const ip of line.match(IPV4) || []) {
      if (!allowedIp(ip)) hits.push({ at, rule: 'ipv4', value: ip });
    }
    if (PRIVATE_KEY.test(line)) hits.push({ at, rule: 'private-key' });
    patterns.forEach((re, n) => { if (re.test(line)) hits.push({ at, rule: `private pattern #${n + 1}` }); });
  });
  return hits;
}

/** Added lines of the staged diff, grouped per file with their new line numbers. */
function stagedAdditions(cwd) {
  const diff = execFileSync('git', ['diff', '--cached', '-U0', '--no-color'], { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const files = [];
  let current, lineNo = 0;
  for (const line of diff.split('\n')) {
    if (line.startsWith('+++ ')) { current = { file: line.slice(6), lines: [] }; files.push(current); continue; }
    const hunk = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)/);
    if (hunk) { lineNo = Number(hunk[1]); continue; }
    if (current && line.startsWith('+') && !line.startsWith('+++')) current.lines.push([lineNo++, line.slice(1)]);
  }
  return files;
}

function main() {
  const cwd = process.cwd();
  const { patterns, file, found } = loadPatterns();
  const hits = [];
  if (process.argv.includes('--all')) {
    const tracked = execFileSync('git', ['ls-files', '-z'], { cwd, encoding: 'utf8' }).split('\0').filter(Boolean);
    for (const f of tracked) {
      let text;
      try { text = fs.readFileSync(path.join(cwd, f), 'utf8'); } catch { continue; }
      if (text.includes('\0')) continue;   // binary
      hits.push(...scanText(text, patterns, f));
    }
  } else {
    for (const { file: f, lines } of stagedAdditions(cwd)) {
      for (const [n, text] of lines) hits.push(...scanText(text, patterns).map((h) => ({ ...h, at: `${f}:${n}` })));
    }
  }
  if (!found) console.log(`note: no private pattern list at ${file}; only the built-in rules ran`);
  for (const h of hits) console.log(`${h.at}  ${h.rule}${h.value ? ' ' + h.value : ''}`);
  console.log(hits.length ? `${hits.length} possible leak(s). Replace with documentation values, or mark a deliberate fixture with "${ALLOW}".` : 'No leaks found.');
  process.exitCode = hits.length ? 1 : 0;
}

if (require.main === module) main();
module.exports = { scanText, loadPatterns, allowedIp, stagedAdditions };
