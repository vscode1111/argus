#!/usr/bin/env node
// Report whether the Argus daemon is up and where to open it. Used by
// cmd/start-argus-daemon.bat after it launches the daemon windowless: without it the
// launcher printed only "launch requested" and closed, so a daemon that was already
// running (the second launch exits at once, by design) looked like one that failed.
//
//   node scripts/daemon-status.js [--wait <seconds>]
//
// Exit 0 when the daemon answers, 1 when it does not. Dependency-free on purpose, like
// daemon-stop.js: the discovery-file rule is duplicated from src/backend/daemonInfo.ts.
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

function discoveryFile() {
  if (process.env.ARGUS_DAEMON_FILE) return process.env.ARGUS_DAEMON_FILE;
  const current = path.join(os.homedir(), '.argus', 'daemon.json');
  return fs.existsSync(current) ? current : path.join(os.homedir(), '.claude', 'argus-daemon.json');
}

function readInfo() {
  try {
    const info = JSON.parse(fs.readFileSync(discoveryFile(), 'utf8'));
    return typeof info.port === 'number' ? info : undefined;
  } catch { return undefined; }
}

/** GET /health on loopback; resolves the parsed body or undefined. */
function health(port, timeoutMs = 2000) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/health', timeout: timeoutMs }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => {
        try {
          const parsed = JSON.parse(body);
          resolve(res.statusCode === 200 && typeof parsed.pid === 'number' ? parsed : undefined);
        } catch { resolve(undefined); }
      });
    });
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve(undefined));
  });
}

// Hyper-V/WSL/VM switches carry host-only addresses no other device can reach (and a
// certificate would not name), so they are left out of "from your network".
const VIRTUAL_ADAPTER = /vEthernet|WSL|Hyper-V|VirtualBox|VMware|docker|Loopback/i;

/** Non-loopback IPv4 addresses of real adapters, for the "from your network" lines. */
function lanAddresses(interfaces = os.networkInterfaces()) {
  return Object.entries(interfaces)
    .filter(([name]) => !VIRTUAL_ADAPTER.test(name))
    .flatMap(([, list]) => (list || []))
    .filter((a) => a.family === 'IPv4' && !a.internal).map((a) => a.address);
}

/**
 * Tunnel or proxy addresses: the allowedOrigins entries that name a port, i.e. the
 * address a remote browser actually opens (e.g. a VPN-side host:port). Entries without
 * a port are LAN-style host allowances, not something to open.
 */
function tunnelAddresses(configPath) {
  try {
    const list = String(JSON.parse(fs.readFileSync(configPath, 'utf8')).allowedOrigins || '');
    return list.split(',').map((s) => s.trim()).filter((s) => /^[^:/\s]+:\d+$/.test(s));
  } catch { return []; }
}

/** The text the launcher prints. Pure, so it is tested without a daemon. */
function describe(info, h, lan = [], tunnels = []) {
  if (!info || !h) {
    return [
      'Argus daemon is NOT running.',
      info ? `Registered on port ${info.port}, but it does not answer.` : 'No daemon is registered.',
      'Start it again, or run "yarn daemon" in the argus folder to see the error.',
    ].join('\n');
  }
  const lines = [
    `Argus daemon is running (version ${info.version || '?'}, pid ${h.pid}).`,
    '',
    `Open on this computer:   http://127.0.0.1:${info.port}/`,
  ];
  const https = h.https || { state: 'off' };
  if (https.state === 'ready') {
    for (const ip of lan) lines.push(`From your network:       https://${ip}:${https.port}/`);
    for (const t of tunnels) lines.push(`Through tunnel/proxy:    https://${t}/`);
  } else if (https.state === 'starting') {
    lines.push(`HTTPS on port ${https.port} is waiting for the port: ${https.error || 'busy'}`);
  } else if (https.state === 'failed') {
    lines.push(`HTTPS is not working: ${https.error || 'unknown error'}`);
  }
  return lines.join('\n');
}

async function main() {
  const i = process.argv.indexOf('--wait');
  const waitMs = (i > 0 ? Number(process.argv[i + 1]) : 10) * 1000;
  const end = Date.now() + waitMs;
  let info, h;
  do {
    info = readInfo();
    h = info ? await health(info.port) : undefined;
    if (h) break;
    await new Promise((r) => setTimeout(r, 500));
  } while (Date.now() < end);
  console.log(describe(info, h, lanAddresses(), h && h.configPath ? tunnelAddresses(h.configPath) : []));
  process.exitCode = h ? 0 : 1;
}

if (require.main === module) main();
module.exports = { describe, health, readInfo, lanAddresses, tunnelAddresses };
