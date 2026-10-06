const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

const root = path.resolve(__dirname, '..');

function withHome(run) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'scub-argus-path-'));
  try { run(home); }
  finally {
    assert.ok(path.resolve(home).startsWith(path.resolve(os.tmpdir()) + path.sep));
    fs.rmSync(home, { recursive: true, force: true });
  }
}

function child(home, code, extraEnv = {}) {
  const result = spawnSync(process.execPath, ['-e', code], {
    cwd: root,
    env: { ...process.env, HOME: home, USERPROFILE: home, ARGUS_CONFIG: '', ARGUS_AUTH_FILE: '', ARGUS_DAEMON_FILE: '', ...extraEnv },
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

test('migrates Argus settings, auth, and provider records into the Argus directory', () => withHome((home) => {
  const oldDir = path.join(home, '.claude');
  fs.mkdirSync(oldDir);
  fs.writeFileSync(path.join(oldDir, 'argus.json'), JSON.stringify({ showTimer: false }));
  fs.writeFileSync(path.join(oldDir, 'argus-auth.json'), JSON.stringify({ user: 'scub-user', salt: 'scub-salt', hash: 'scub-hash' }));
  fs.writeFileSync(path.join(oldDir, 'argus-provider-sessions.json'), JSON.stringify([{
    id: 'scub-session', cwd: 'scub-workspace', title: 'scub-title', updatedAt: 1,
    selection: { providerId: 'scub-provider', model: 'scub-model', effort: '', thinking: false },
  }]));
  const data = child(home, `const c=require('./out/backend/config'); const a=require('./out/backend/auth'); const s=require('./out/backend/providers/store'); console.log(JSON.stringify({path:c.CONFIG_PATH,showTimer:c.readConfig().showTimer,user:a.readAuth()?.user,records:s.records().length}))`);
  assert.equal(data.path, path.join(home, '.argus', 'config.json'));
  assert.equal(data.showTimer, false);
  assert.equal(data.user, 'scub-user');
  assert.equal(data.records, 1);
  for (const name of ['argus.json', 'argus-auth.json', 'argus-provider-sessions.json']) assert.equal(fs.existsSync(path.join(oldDir, name)), true);
  for (const name of ['config.json', 'auth.json', 'argus-provider-sessions.json']) assert.equal(fs.existsSync(path.join(home, '.argus', name)), true);
}));

test('explicit paths leave legacy files alone', () => withHome((home) => {
  const oldDir = path.join(home, '.claude');
  fs.mkdirSync(oldDir);
  fs.writeFileSync(path.join(oldDir, 'argus.json'), '{}');
  fs.writeFileSync(path.join(oldDir, 'argus-auth.json'), '{}');
  const config = path.join(home, 'scub-config.json');
  const auth = path.join(home, 'scub-auth.json');
  const data = child(home, `const c=require('./out/backend/config'); const a=require('./out/backend/auth'); c.readConfig(); a.readAuth(); console.log(JSON.stringify({config:c.CONFIG_PATH,auth:a.authFilePath()}))`, { ARGUS_CONFIG: config, ARGUS_AUTH_FILE: auth });
  assert.equal(data.config, config);
  assert.equal(data.auth, auth);
  assert.equal(fs.existsSync(path.join(oldDir, 'argus.json')), true);
  assert.equal(fs.existsSync(path.join(oldDir, 'argus-auth.json')), true);
}));

test('uses a live legacy daemon registration until the new daemon writes its own', () => withHome((home) => {
  const oldDir = path.join(home, '.claude');
  fs.mkdirSync(oldDir);
  const legacy = { port: 3017, nonce: 'scub-nonce', pid: 42, version: 'scub-version', startedAt: 1 };
  fs.writeFileSync(path.join(oldDir, 'argus-daemon.json'), JSON.stringify(legacy));
  const data = child(home, `const d=require('./out/backend/daemonInfo'); const old=d.readDaemonInfo(); d.writeDaemonInfo({...old,pid:43}); const next=d.readDaemonInfo(); d.clearDaemonInfo(42); const still=d.readDaemonInfo(); d.clearDaemonInfo(43); console.log(JSON.stringify({path:d.DAEMON_FILE,old:old.pid,next:next.pid,still:still.pid}))`);
  assert.equal(data.path, path.join(home, '.argus', 'daemon.json'));
  assert.deepEqual([data.old, data.next, data.still], [42, 43, 43]);
  assert.equal(fs.existsSync(path.join(home, '.argus', 'daemon.json')), false);
  assert.equal(fs.existsSync(path.join(oldDir, 'argus-daemon.json')), true);
}));
