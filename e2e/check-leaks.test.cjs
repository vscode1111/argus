// scripts/check-leaks.js: the guard against publishing infrastructure details.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { scanText, loadPatterns } = require('../scripts/check-leaks.js');

const SCRIPT = path.resolve(__dirname, '..', 'scripts', 'check-leaks.js');

test('a real-looking IPv4 is flagged; loopback, documentation ranges and versions are not', () => {
  const hits = scanText([
    "const EXIT = '198.18.0.1';",       // benchmark range: not documentation, so flagged leak-check: allow
    "const LAN = '10.20.30.40';", // leak-check: allow (fixture)
    'listen on 127.0.0.1 and 0.0.0.0',
    'doc 192.0.2.10 198.51.100.7 203.0.113.5',
    'version 1.2.3.4567',
  ].join('\n'));
  assert.deepEqual(hits.map((h) => [h.at, h.value]), [['1', '198.18.0.1'], ['2', '10.20.30.40']]); // leak-check: allow (fixture)
});

test('a private key block is flagged, and an explicit allow marker skips a line', () => {
  assert.deepEqual(scanText('-----BEGIN EC PRIVATE KEY-----').map((h) => h.rule), ['private-key']); // leak-check: allow (fixture for the private-key rule)
  assert.deepEqual(scanText("address: '10.1.2.3', // leak-check: allow"), []);
});

test('private patterns catch values the built-in rules cannot, without echoing them', () => {
  // A documentation address the owner really uses is invisible to the IPv4 rule, which is
  // exactly why the private list exists.
  const hits = scanText('open https://203.0.113.77:41443/', [/203\.0\.113\.77/i, /:41443\b/]);
  assert.deepEqual(hits.map((h) => h.rule), ['private pattern #1', 'private pattern #2']);
  assert.ok(hits.every((h) => h.value === undefined), 'a private match must not be printed');
});

test('the private list is read from a file outside the repository, comments ignored', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'argus-leaks-'));
  const file = path.join(dir, 'leak-patterns.txt');
  fs.writeFileSync(file, '# real values\n\nsecret-host\\.example\n');
  try {
    const { patterns, found } = loadPatterns(file);
    assert.equal(found, true);
    assert.equal(patterns.length, 1);
    assert.equal(loadPatterns(path.join(dir, 'missing.txt')).found, false);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('the CLI checks only staged additions and fails on a leak', () => {
  // A throwaway repository: one clean commit, then a staged line with a leak.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'argus-leaks-repo-'));
  const git = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' });
  const run = () => {
    try { return { code: 0, out: execFileSync(process.execPath, [SCRIPT], { cwd: dir, encoding: 'utf8', env: { ...process.env, ARGUS_LEAK_PATTERNS: path.join(dir, 'none.txt') } }) }; }
    catch (e) { return { code: e.status, out: String(e.stdout) }; }
  };
  try {
    git('init', '-q');
    git('config', 'user.email', 'test@example.com'); git('config', 'user.name', 'test');
    fs.writeFileSync(path.join(dir, 'a.txt'), "old = '10.0.0.1'\n");   // already committed: not this check's business leak-check: allow
    git('add', '.'); git('commit', '-qm', 'base');
    assert.equal(run().code, 0);
    fs.appendFileSync(path.join(dir, 'a.txt'), "new = '172.16.5.9'\n"); // leak-check: allow (fixture)
    git('add', '.');
    const r = run();
    assert.equal(r.code, 1);
    assert.match(r.out, /a\.txt:2 {2}ipv4 172\.16\.5\.9/);
    assert.doesNotMatch(r.out, /10\.0\.0\.1/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
