// Drive the Claude CLI with Argus's own spawn flags and record every stdout event that
// comes back from a Read of a large image. Prints the SHAPE of each event (base64 elided)
// so we can see exactly what the live path in cliHandler.handleUserEvent receives - in
// particular whether the "[Image: original ...]" meta note arrives as a string or as a
// text block, and whether the envelope carries isMeta.
//
// Usage: node probe-cli-image.js <imagePath> [outFile]
const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const imagePath = process.argv[2];
const outFile = process.argv[3] || path.join(__dirname, 'probe-out.json');

function resolveClaudeBin() {
  if (process.platform !== 'win32') return 'claude';
  try {
    const out = execFileSync('where', ['claude.cmd'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
    const hit = out.split(/\r?\n/).map((l) => l.trim()).find(Boolean);
    if (hit && fs.existsSync(hit)) return hit;
  } catch {}
  return 'claude';
}

const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'scub-probe-'));
const args = [
  '--print', '--verbose',
  '--output-format', 'stream-json',
  '--input-format', 'stream-json',
  '--include-partial-messages',
  '--tools', 'Read',
  '--allowedTools', 'Read',
];

const bin = resolveClaudeBin();
console.log(`cwd=${cwd}\nbin=${bin}\nimage=${imagePath}`);

const proc = spawn(bin, args, { cwd, shell: process.platform === 'win32', windowsHide: true });

const events = [];
let buf = '';
const elide = (v) => {
  if (typeof v === 'string') return v.length > 200 ? `${v.slice(0, 200)}…(${v.length})` : v;
  if (Array.isArray(v)) return v.map(elide);
  if (v && typeof v === 'object') {
    const o = {};
    for (const [k, val] of Object.entries(v)) o[k] = k === 'data' ? `<b64 ${String(val).length}>` : elide(val);
    return o;
  }
  return v;
};

proc.stdout.on('data', (d) => {
  buf += d.toString();
  const lines = buf.split('\n');
  buf = lines.pop() || '';
  for (const line of lines) {
    if (!line.trim()) continue;
    let e;
    try { e = JSON.parse(line); } catch { continue; }
    events.push(elide(e));
    if (e.type === 'user') {
      const c = e.message?.content;
      const kind = typeof c === 'string' ? `string: ${JSON.stringify(c.slice(0, 130))}`
        : Array.isArray(c) ? c.map((b) => (b?.type === 'text' ? `text:${JSON.stringify(String(b.text).slice(0, 130))}` : b?.type)).join(' | ')
        : typeof c;
      console.log(`USER EVENT  isMeta=${e.isMeta}  keys=[${Object.keys(e).join(',')}]\n            ${kind}`);
    }
    if (e.type === 'result') console.log(`RESULT is_error=${e.is_error} num_turns=${e.num_turns}`);
  }
});
proc.stderr.on('data', (d) => process.stderr.write(d));

proc.on('close', (code) => {
  fs.writeFileSync(outFile, JSON.stringify(events, null, 2));
  console.log(`\nexit=${code}  events=${events.length}  written=${outFile}`);
});

const prompt = `Read the file ${imagePath} then reply with the single word done.`;
proc.stdin.write(JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: prompt }] } }) + '\n');

setTimeout(() => { try { proc.kill(); } catch {} }, 180000);
