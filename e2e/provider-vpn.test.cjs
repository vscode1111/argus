const assert = require('node:assert/strict');
const { mkdtempSync, rmSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { after, test } = require('node:test');

const dir = mkdtempSync(join(tmpdir(), 'argus-route-test-'));
process.env.ARGUS_CONFIG = join(dir, 'settings.json');
delete process.env.ARGUS_DEDICATED_LAUNCHER;
delete process.env.ARGUS_VPN_PROFILES;
const { readConfig, writeConfig } = require('../out/backend/config');
const { checkProviderVpn, isProviderVpnMode, listProviderVpnProfiles, providerCommand, providerNetworkEnvironment, vpnMode } = require('../out/backend/providerVpn');
const { AppServerRpc } = require('../out/backend/providers/rpc');
const { handleSend } = require('../out/backend/providers/claudeExecution');
const { createSessionState } = require('../out/backend/sessionState');
after(() => rmSync(dir, { recursive: true, force: true }));

test('provider modes are independent and persist, with normal as the legacy default', () => {
  assert.equal(vpnMode('claude'), 'normal');
  assert.equal(vpnMode('codex'), 'normal');
  writeConfig({ ...readConfig(), claudeVpnMode: 'dedicated' });
  assert.equal(vpnMode('claude'), 'dedicated');
  assert.equal(vpnMode('codex'), 'normal');
  writeConfig({ ...readConfig(), claudeVpnMode: 'normal', codexVpnMode: 'dedicated' });
  assert.equal(vpnMode('claude'), 'normal');
  assert.equal(vpnMode('codex'), 'dedicated');
  writeConfig({ ...readConfig(), codexVpnMode: 'normal' });
  assert.equal(vpnMode('codex'), 'normal');
});

test('protected commands do not fall back when the trusted launcher is missing', async () => {
  writeConfig({ ...readConfig(), claudeVpnMode: 'dedicated', codexVpnMode: 'dedicated' });
  for (const provider of ['claude', 'codex']) {
    assert.throws(() => providerCommand(provider, vpnMode(provider), 'example', ['status']), /isolation launcher is unavailable/);
    const result = await checkProviderVpn(provider);
    assert.equal(result.mode, 'dedicated');
    assert.equal(result.exitIp, undefined);
    assert.equal(result.apiStatus, undefined);
    assert.match(result.error, /isolation launcher is unavailable/);
    assert.ok(Date.parse(result.checkedAt));
  }
  const rpc = new AppServerRpc('example');
  await assert.rejects(rpc.start(), /isolation launcher is unavailable/);
  assert.equal(rpc.pid, undefined);
  rpc.dispose();

  const state = createSessionState(dir);
  const events = [];
  state.sendLog = () => {};
  state.resetStaleTimer = () => {};
  state.watchdog = { state: { autoRetryCount: 0, active: false } };
  state.broadcast = message => events.push(JSON.parse(message));
  handleSend(state, { text: 'Summarize the green sample' });
  assert.equal(state.currentProc, undefined);
  assert.equal(state.cliDone, true);
  assert.match(events.find(event => event.type === 'error').text, /isolation launcher is unavailable/);
  assert.equal(events.at(-1).type, 'done');
});

test('protected launch requires a dedicated proxy and replaces inherited bypass rules', () => {
  const normal = { HTTPS_PROXY: 'http://127.0.0.1:8080' };
  assert.equal(providerNetworkEnvironment('normal', normal), normal);
  assert.throws(() => providerNetworkEnvironment('dedicated', normal), /dedicated HTTP proxy/);
  const localProxy = 'http://127.0.0.1:8484';
  const env = providerNetworkEnvironment('dedicated', {
    ...normal, https_proxy: normal.HTTPS_PROXY, no_proxy: '*',
    ARGUS_DEDICATED_PROXY: localProxy, ARGUS_DAEMON_PORT: '3017',
  });
  assert.equal(env.HTTPS_PROXY, localProxy);
  assert.equal(env.https_proxy, undefined);
  assert.equal(env.no_proxy, undefined);
  assert.equal(env.NO_PROXY, 'localhost,127.0.0.1,::1');
  assert.equal(env.ARGUS_DAEMON_PORT, '3017');
});

test('malformed stored mode cannot authorize a normal provider command', () => {
  writeFileSync(process.env.ARGUS_CONFIG, JSON.stringify({ claudeVpnMode: 'unexpected' }));
  assert.throws(() => providerCommand('claude', vpnMode('claude'), 'example', []), /route is unavailable/);
  assert.equal(vpnMode('codex'), 'normal');
  writeFileSync(process.env.ARGUS_CONFIG, '{');
  for (const provider of ['claude', 'codex']) {
    assert.throws(() => providerCommand(provider, vpnMode(provider), 'example', []), /route is unavailable/);
  }
});

test('configured profile IDs select their respective launchers and proxies and can be removed safely', async () => {
  const profiles = [
    { id: 'paris', label: 'Paris only', launcher: process.execPath, proxy: 'http://127.0.0.1:8484', exitIps: ['192.0.2.10', '192.0.2.11'] },
    { id: 'london', label: 'London only', launcher: join(dir, 'isolation.exe'), proxy: 'http://127.0.0.1:8585', exitIps: ['192.0.2.20'] },
  ];
  process.env.ARGUS_VPN_PROFILES = JSON.stringify(profiles);
  try {
    writeConfig({ ...readConfig(), claudeVpnMode: 'paris', codexVpnMode: 'london' });
    assert.deepEqual(listProviderVpnProfiles(), profiles.map(({ id, label }) => ({ id, label })));
    assert.equal(vpnMode('claude'), 'paris');
    assert.equal(vpnMode('codex'), 'london');
    assert.equal(isProviderVpnMode('paris'), true);
    assert.equal(isProviderVpnMode('dedicated'), false);
    assert.equal(providerCommand('claude', 'paris', 'example', []).binary, process.execPath);
    for (const profile of profiles) {
      assert.equal(providerNetworkEnvironment(profile.id, process.env).HTTPS_PROXY, profile.proxy);
    }
    assert.throws(() => providerCommand('codex', 'london', 'example', []), /London only:.*launcher is unavailable/);

    process.env.ARGUS_VPN_PROFILES = JSON.stringify(profiles.slice(1));
    const result = await checkProviderVpn('claude');
    assert.equal(result.mode, 'paris');
    assert.match(result.error, /route is unavailable/);
    assert.equal(result.exitIp, undefined);

    process.env.ARGUS_VPN_PROFILES = JSON.stringify([profiles[0], profiles[0]]);
    assert.deepEqual(listProviderVpnProfiles(), []);
    assert.equal(isProviderVpnMode('paris'), false);
    assert.equal(isProviderVpnMode('normal'), true);
  } finally {
    delete process.env.ARGUS_VPN_PROFILES;
  }
});

test('route check compares the observed IP against the selected profile allowlist', async t => {
  const { EventEmitter } = require('node:events');
  const { PassThrough } = require('node:stream');
  process.env.ARGUS_VPN_PROFILES = JSON.stringify([
    { id: 'paris', label: 'Paris only', launcher: process.execPath, proxy: 'http://127.0.0.1:8484', exitIps: ['192.0.2.10', '192.0.2.11'] },
  ]);
  writeConfig({ ...readConfig(), claudeVpnMode: 'paris' });
  let observedIp = '192.0.2.11';
  t.mock.method(require('node:child_process'), 'spawn', (_binary, args) => {
    const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stdin: new PassThrough() });
    const exitProbe = args.at(-1) === 'https://api.ipify.org/';
    queueMicrotask(() => {
      child.stdout.end(exitProbe ? `${observedIp}\n200` : '\n401');
      child.emit('close', 0);
    });
    return child;
  });
  try {
    const match = await checkProviderVpn('claude');
    assert.equal(match.exitIp, observedIp);
    assert.equal(match.error, undefined);
    assert.equal(match.apiStatus, 401);

    observedIp = '192.0.2.99';
    const mismatch = await checkProviderVpn('claude');
    assert.equal(mismatch.exitIp, observedIp);
    assert.match(mismatch.error, /Unexpected exit IP for Paris only/);
    assert.equal(mismatch.apiStatus, 401);
  } finally {
    delete process.env.ARGUS_VPN_PROFILES;
  }
});

test('the default route takes its expected exit addresses from the environment, never from code', () => {
  // The repository is public: a hardcoded exit address named a server in the owner's VPN
  // chain. With nothing configured the list is empty, so the route check fails closed.
  const { exitIpsFrom } = require('../out/backend/providerVpn');
  assert.deepEqual(exitIpsFrom(undefined), []);
  assert.deepEqual(exitIpsFrom(''), []);
  assert.deepEqual(exitIpsFrom(' 192.0.2.10 , not-an-ip, 198.51.100.7,::1 '), ['192.0.2.10', '198.51.100.7']);
  const source = require('node:fs').readFileSync(require.resolve('../out/backend/providerVpn'), 'utf8');
  const literals = (source.match(/['"](\d{1,3}\.){3}\d{1,3}['"]/g) || []);
  assert.deepEqual(literals, [], 'no IPv4 literal may appear in the compiled route module');
});
