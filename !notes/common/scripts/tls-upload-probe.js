#!/usr/bin/env node
// Size-sweep probe: does a POST of a given size survive the direct network path, and does the
// TLS version change the outcome? Written for the "Claude CLI: Connection error / ECONNRESET"
// investigation, see ../claude-code-network-path.md.
//
// Usage: node tls-upload-probe.js [--host api.anthropic.com] [--path /v1/messages] [--sizes 0.1,8,32,200]
//
// It sends an INVALID fake key, so a healthy path answers HTTP 401 at every size. The failure
// signature is ERR_SSL_SSL/TLS_ALERT_BAD_RECORD_MAC: the peer rejected our bytes as corrupted.
// No real credential is used or needed.
//
// Two traps this script deliberately avoids (both measured 2026-09-25, see the doc):
// - Let https.request build the socket itself (TLS options go in the request options). A hand
//   built tls.connect() socket handed over via createConnection FAILS even on TLS 1.2 on the
//   same route, so it is not a valid control and would report a false failure.
// - There is no --proxy mode: the only way to reach a CONNECT proxy from Node is exactly such a
//   hand built socket, so a result there could not be trusted. To test the proxy path, run the
//   real CLI with HTTPS_PROXY set instead.
const https = require('https');

const args = {};
process.argv.slice(2).forEach((v, i, all) => { if (v.startsWith('--')) args[v.slice(2)] = all[i + 1]; });
const host = args.host || 'api.anthropic.com';
const path = args.path || '/v1/messages';
const sizesKb = (args.sizes || '0.1,8,32,200').split(',').map(Number);

function post(bytes, tlsOpts) {
  return new Promise(resolve => {
    const t0 = Date.now();
    let proto = '?';
    const req = https.request({
      host, path, method: 'POST', family: 4, agent: false, timeout: 20000, ...tlsOpts,
      headers: { 'content-type': 'application/json', 'x-api-key': 'sk-ant-scub-invalid', 'anthropic-version': '2023-06-01', 'content-length': bytes },
    }, res => { res.resume(); res.on('end', () => resolve(`HTTP ${res.statusCode} ${Date.now() - t0}ms ${proto}`)); });
    req.on('socket', s => s.on('secureConnect', () => { proto = s.getProtocol(); }));
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', e => resolve(`ERROR ${e.code || e.message} ${proto}`));
    req.end('x'.repeat(bytes));
  });
}

(async () => {
  const variants = [['TLS default (1.3)', {}], ['TLS 1.2 only', { maxVersion: 'TLSv1.2' }]];
  const ok = {};
  console.log(`target ${host}${path}, direct route (whatever the OS routes, TUN included)`);
  for (const [name, opts] of variants) {
    ok[name] = [];
    for (const kb of sizesKb) {
      const r = await post(Math.round(kb * 1024), opts);
      ok[name].push(r.startsWith('HTTP'));
      console.log(`${name.padEnd(18)} ${String(kb).padStart(6)} KB  ${r}`);
    }
  }
  const d = ok['TLS default (1.3)'];
  const t12 = ok['TLS 1.2 only'];
  if (d.every(Boolean) && t12.every(Boolean)) console.log('VERDICT: path healthy at every size');
  else if (!d.every(Boolean) && t12.every(Boolean)) console.log('VERDICT: SIGNATURE, large TLS 1.3 uploads fail while TLS 1.2 passes (see claude-code-network-path.md)');
  else console.log('VERDICT: mixed failures, inspect the table above');
})();
