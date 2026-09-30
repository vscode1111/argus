const fs = require('fs');
const os = require('os');
const path = require('path');
const WebSocket = require(path.resolve(__dirname, '../../../../node_modules/ws'));

const dir = path.join(os.homedir(), '.claude');
const info = JSON.parse(fs.readFileSync(path.join(dir, 'argus-daemon.json'), 'utf8'));
const config = JSON.parse(fs.readFileSync(path.join(dir, 'argus.json'), 'utf8'));
let records = [];
try { records = JSON.parse(fs.readFileSync(path.join(dir, 'argus-provider-sessions.json'), 'utf8')); } catch {}
const byId = new Map(records.map(r => [r.id, r]));
const ws = new WebSocket(`ws://127.0.0.1:${info.port}/agent?nonce=${encodeURIComponent(info.nonce)}&dir=${encodeURIComponent(process.cwd())}`);
const replies = new Map();
const timer = setTimeout(() => { console.error('Timed out waiting for server replies'); ws.terminate(); process.exitCode = 1; }, 15000);
ws.on('message', raw => {
  const msg = JSON.parse(raw.toString());
  if (msg.type !== 'serverInfo' && msg.type !== 'cliProcessList') return;
  replies.set(msg.type, msg);
  if (replies.size !== 2) return;
  clearTimeout(timer);
  const now = Date.now();
  const rows = replies.get('cliProcessList').processes.map(p => {
    const record = byId.get(p.sessionId);
    return {
      pid: p.pid,
      ownerPid: p.owner?.pid,
      ours: p.ours,
      running: p.sessionRunning,
      provider: p.sessionId?.split(':')[0] || '-',
      ageSec: Math.round((now - p.startedAt) / 1000),
      lastTurnAgeSec: record ? Math.round((now - record.updatedAt) / 1000) : null,
    };
  });
  console.log(JSON.stringify({ daemonVersion: info.version, idleTimeoutSec: config.cliIdleTimeoutSec,
    cliLaunchCount: replies.get('serverInfo').cliLaunchCount, rows }, null, 2));
  ws.close();
});
ws.on('open', () => {
  ws.send(JSON.stringify({ type: 'getServerInfo' }));
  ws.send(JSON.stringify({ type: 'listCliProcesses' }));
});
ws.on('error', err => { clearTimeout(timer); console.error(err.message); process.exitCode = 1; });
