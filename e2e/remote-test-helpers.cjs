// Shared helpers for the remote-access backend tests (access log, HTTPS).
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

/**
 * A non-loopback IPv4 address of this machine that reaches `port`. Connecting to it
 * gives the server a non-loopback peer address, i.e. the exact path a phone takes, so
 * the remote gate can be tested without a second machine. Undefined when the machine
 * has no such interface (a sandbox), so the caller can skip rather than fail.
 */
async function lanAddress(port, scheme = 'http') {
  const addresses = Object.values(os.networkInterfaces()).flatMap((entries) =>
    (entries ?? []).filter((e) => e.family === 'IPv4' && !e.internal).map((e) => e.address));
  for (const address of addresses) {
    try {
      await new Promise((resolve, reject) => {
        const socket = require('node:net').connect({ host: address, port, timeout: 1500 });
        socket.once('connect', () => { socket.destroy(); resolve(); });
        socket.once('timeout', () => { socket.destroy(); reject(new Error('timeout')); });
        socket.once('error', reject);
      });
      return address;
    } catch { /* try the next interface */ }
  }
  return undefined;
}

function findOpenssl() {
  const candidates = [
    'openssl',
    'C:/Program Files/Git/mingw64/bin/openssl.exe',
    'C:/Program Files/Git/usr/bin/openssl.exe',
  ];
  for (const bin of candidates) {
    try { execFileSync(bin, ['version'], { stdio: 'ignore' }); return bin; } catch { /* next */ }
  }
  return undefined;
}

/**
 * Throwaway CA + server certificate for the given SANs, generated per run into `dir`.
 * Nothing is committed: a test key in the repository would still be a private key in
 * the repository. Returns undefined when no openssl is available.
 */
function makeCerts(dir, { ips = ['127.0.0.1'], dns = ['localhost'] } = {}) {
  const openssl = findOpenssl();
  if (!openssl) return undefined;
  const f = (name) => path.join(dir, name);
  const run = (...args) => execFileSync(openssl, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  run('genpkey', '-algorithm', 'EC', '-pkeyopt', 'ec_paramgen_curve:P-256', '-out', f('ca.key'));
  run('req', '-x509', '-new', '-key', f('ca.key'), '-sha256', '-days', '2', '-subj', '/CN=Argus Test CA',
    '-addext', 'basicConstraints=critical,CA:TRUE', '-addext', 'keyUsage=critical,keyCertSign', '-out', f('ca.crt'));
  run('genpkey', '-algorithm', 'EC', '-pkeyopt', 'ec_paramgen_curve:P-256', '-out', f('server.key'));
  run('req', '-new', '-key', f('server.key'), '-subj', '/CN=Argus Test', '-out', f('server.csr'));
  const san = [...ips.map((ip) => `IP:${ip}`), ...dns.map((d) => `DNS:${d}`)].join(',');
  fs.writeFileSync(f('ext.cnf'), `basicConstraints=CA:FALSE\nextendedKeyUsage=serverAuth\nsubjectAltName=${san}\n`);
  run('x509', '-req', '-in', f('server.csr'), '-CA', f('ca.crt'), '-CAkey', f('ca.key'), '-CAcreateserial',
    '-days', '2', '-sha256', '-extfile', f('ext.cnf'), '-out', f('server.crt'));
  // A second, unrelated key for the "key does not match certificate" case.
  run('genpkey', '-algorithm', 'EC', '-pkeyopt', 'ec_paramgen_curve:P-256', '-out', f('other.key'));
  return {
    ca: fs.readFileSync(f('ca.crt'), 'utf8'),
    cert: fs.readFileSync(f('server.crt'), 'utf8'),
    key: fs.readFileSync(f('server.key'), 'utf8'),
    certFile: f('server.crt'),
    keyFile: f('server.key'),
    otherKeyFile: f('other.key'),
  };
}

/** Set env vars for the duration of a test; returns a restore function. */
function withEnv(vars) {
  const prior = {};
  for (const [k, v] of Object.entries(vars)) {
    prior[k] = process.env[k];
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
  return () => {
    for (const [k, v] of Object.entries(prior)) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  };
}

module.exports = { lanAddress, makeCerts, withEnv };
