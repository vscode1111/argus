const { test } = require('node:test');
const assert = require('node:assert/strict');
const { AppServerRpc } = require('../out/backend/providers/rpc');
const { codexProvider } = require('../out/backend/providers/codex');

test('slash skill list keeps the first invokable entry for each name', async () => {
  const original = {
    start: AppServerRpc.prototype.start,
    request: AppServerRpc.prototype.request,
    dispose: AppServerRpc.prototype.dispose,
  };
  AppServerRpc.prototype.start = async () => {};
  AppServerRpc.prototype.request = async method => {
    assert.equal(method, 'skills/list');
    return { data: [{ skills: [
      { name: 'release-notes', description: 'Unavailable copy', path: '/skills/disabled/release-notes', enabled: false },
      { name: 'release-notes', description: 'Prepare release notes', path: '/skills/active/release-notes', enabled: true },
      { name: 'quality-check', description: 'Check the release', path: '/skills/quality-check', enabled: true },
      { name: 'release-notes', description: 'Later copy', path: '/skills/later/release-notes', enabled: true },
    ] }] };
  };
  AppServerRpc.prototype.dispose = () => {};
  try {
    const skills = await codexProvider.skills('/workspace');
    assert.deepEqual(skills, [
      { name: 'release-notes', description: 'Prepare release notes', path: '/skills/active/release-notes', kind: 'skill', scope: 'provider' },
      { name: 'quality-check', description: 'Check the release', path: '/skills/quality-check', kind: 'skill', scope: 'provider' },
    ]);
  } finally {
    Object.assign(AppServerRpc.prototype, original);
  }
});
