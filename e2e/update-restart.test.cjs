// When an open VS Code window restarts its extension host to load a newer installed
// Argus (src/frontend/updateRestart.ts). Runs against the compiled module; it has no
// vscode import, so plain `node --test` drives it. Each "no" case is a guard against a
// restart that would reload the same old code, or loop.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { decideUpdateRestart, compareVersions } = require('../out/frontend/updateRestart.js');

function extensionsDir(versions) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'argus-ext-'));
  for (const [folder, version] of Object.entries(versions)) {
    fs.mkdirSync(path.join(dir, folder));
    if (version) fs.writeFileSync(path.join(dir, folder, 'package.json'), JSON.stringify({ version }));
  }
  return dir;
}

function check(dir, overrides = {}) {
  return decideUpdateRestart({
    extensionId: 'local.argus',
    ownVersion: '0.0.149',
    extensionPath: path.join(dir, 'local.argus-0.0.149'),
    daemonVersion: '0.0.150',
    development: false,
    ...overrides,
  });
}

test('a newer daemon whose version is installed beside this one restarts the window', () => {
  const dir = extensionsDir({ 'local.argus-0.0.149': '0.0.149', 'local.argus-0.0.150': '0.0.150' });
  const result = check(dir);
  assert.equal(result.restart, true);
  assert.equal(result.target, '0.0.150');
  assert.equal(result.installedPath, path.join(dir, 'local.argus-0.0.150'));
});

test('a daemon at or below this version does not restart', () => {
  const dir = extensionsDir({ 'local.argus-0.0.149': '0.0.149', 'local.argus-0.0.150': '0.0.150' });
  assert.equal(check(dir, { daemonVersion: '0.0.149' }).restart, false);
  assert.equal(check(dir, { daemonVersion: '0.0.148' }).restart, false);
  assert.equal(check(dir, { daemonVersion: undefined }).restart, false);
});

test('versions compare numerically, so 0.0.10 is newer than 0.0.9', () => {
  assert.ok(compareVersions('0.0.10', '0.0.9') > 0);
  const dir = extensionsDir({ 'local.argus-0.0.9': '0.0.9', 'local.argus-0.0.10': '0.0.10' });
  const result = check(dir, { ownVersion: '0.0.9', extensionPath: path.join(dir, 'local.argus-0.0.9'), daemonVersion: '0.0.10' });
  assert.equal(result.restart, true);
});

test('a newer daemon that is not installed here does not restart (it would reload the same build)', () => {
  const dir = extensionsDir({ 'local.argus-0.0.149': '0.0.149' });
  const result = check(dir);
  assert.equal(result.restart, false);
  assert.match(result.reason, /not installed/);
  const mismatched = extensionsDir({ 'local.argus-0.0.149': '0.0.149', 'local.argus-0.0.150': '0.0.149' });
  assert.equal(check(mismatched).restart, false);
});

test('a development host never restarts, even with a newer install present', () => {
  const dir = extensionsDir({ 'local.argus-0.0.149': '0.0.149', 'local.argus-0.0.150': '0.0.150' });
  assert.equal(check(dir, { development: true }).restart, false);
  // Running from the repo rather than an installed folder is refused on its own too.
  assert.equal(check(dir, { extensionPath: path.join(dir, 'argus') }).restart, false);
});

test('a window that already tried this target does not try again, but a later target still restarts', () => {
  const dir = extensionsDir({
    'local.argus-0.0.149': '0.0.149', 'local.argus-0.0.150': '0.0.150', 'local.argus-0.0.151': '0.0.151',
  });
  assert.equal(check(dir, { attemptedTarget: '0.0.150' }).restart, false);
  assert.equal(check(dir, { attemptedTarget: '0.0.150', daemonVersion: '0.0.151' }).restart, true);
});
