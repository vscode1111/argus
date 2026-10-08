const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { workspaceChanges } = require('../out/backend/workspaceChanges');

test('workspace totals include staged, unstaged, and untracked text changes', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scub-workspace-changes-'));
  const git = (...args) => execFileSync('git', ['-C', dir, ...args], { stdio: 'ignore', windowsHide: true });
  try {
    git('init');
    fs.writeFileSync(path.join(dir, 'scub-tracked.txt'), 'scub-base\n');
    git('add', '.');
    git('-c', 'user.name=scub-test', '-c', 'user.email=scub@example.com', 'commit', '-m', 'scub-base');
    fs.writeFileSync(path.join(dir, 'scub-tracked.txt'), 'scub-changed\n');
    git('add', '.');
    fs.appendFileSync(path.join(dir, 'scub-tracked.txt'), 'scub-added\n');
    fs.writeFileSync(path.join(dir, 'scub-new.txt'), 'scub-one\nscub-two');
    assert.deepEqual(await workspaceChanges(dir), { added: 4, removed: 1, isIncomplete: false });
  } finally {
    if (!dir.toLowerCase().startsWith((os.tmpdir() + path.sep).toLowerCase())) throw new Error('Unexpected test directory');
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
