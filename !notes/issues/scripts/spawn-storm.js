// Diagnostic: does a burst of concurrent `claude --print` spawns reproduce the
// Bun OOM seen in the integration cascade, and does it correlate with anything
// on the parent side? Spawns N children at once and reports each exit.
const { spawn } = require('child_process');
const N = Number(process.argv[2] || 6);
const bin = process.argv[3] || 'claude';
const args = ['--print', '--output-format', 'stream-json', '--verbose', '--include-partial-messages'];
let done = 0, oom = 0, ok = 0, other = 0;
const t0 = Date.now();
for (let i = 0; i < N; i++) {
  let err = '';
  const p = spawn(bin, args, { stdio: ['pipe', 'pipe', 'pipe'], shell: process.platform === 'win32', windowsHide: true });
  p.stderr.on('data', d => { err += d.toString(); });
  p.stdout.on('data', () => {});
  p.on('error', e => console.log(`[${i}] spawn error: ${e.message}`));
  p.on('close', code => {
    const ms = Date.now() - t0;
    const isOom = /run out of memory/i.test(err);
    if (isOom) oom++; else if (code === 0) ok++; else other++;
    console.log(`[${i}] exit=${code} ${ms}ms ${isOom ? 'BUN-OOM' : ''} ${err.slice(0, 60).replace(/\s+/g, ' ')}`);
    if (++done === N) console.log(`\nSUMMARY n=${N} ok=${ok} bunOom=${oom} otherFail=${other}`);
  });
  p.stdin.write('say hi\n');
  p.stdin.end();
}
